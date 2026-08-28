#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN_URL = "https://lanhuapp.com/web/";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BROKER_PROTOCOL_VERSION = 2;
const BROKER_MAX_MESSAGE_BYTES = 136 * 1024 * 1024;
const BROKER_MAX_REQUEST_BYTES = 128 * 1024;
const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_IDLE_CLIENT_TIMEOUT_MS = 5_000;
const BROKER_MAX_CONNECTIONS = 32;
const BROKER_MAX_QUEUED_REQUESTS = 16;
const BROKER_START_MARKER_MAX_AGE_MS = 30_000;
const BROKER_START_MARKER_MAX_BYTES = 4 * 1024;
const DEFAULT_LOGIN_TIMEOUT_MS = readBoundedInteger(
  "LANHU_LOGIN_TIMEOUT_MS",
  5 * 60_000,
  30_000,
  15 * 60_000,
);
const AUTH_ERROR_CODES = new Set(["4001", "4002", "401", "403"]);
const ALLOWED_CHANNELS = new Set([
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "msedge",
  "msedge-beta",
  "msedge-dev",
  "msedge-canary",
]);
const AUTHENTICATED_ENDPOINTS = new Map([
  ["https://lanhuapp.com", new Set([
    "/api/project/images",
    "/api/project/image",
    "/api/project/multi_info",
  ])],
  ["https://dds.lanhuapp.com", new Set([
    "/api/dds/image/store_schema_revise",
  ])],
]);
const BROKER_ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "referer",
  "request-from",
  "real-path",
  "user-agent",
]);
const BROKER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

let activeContext = null;
let activeHeadless = null;
let browserLaunchPromise = null;
let browserGeneration = 0;
let brokerServer = null;
let brokerServerSocket = null;
let brokerStartPromise = null;
let brokerStopping = false;
let brokerShutdownPromise = null;
let brokerQueue = Promise.resolve();
let brokerQueuedRequests = 0;
let activeBrokerRequestController = null;
const brokerRequestControllers = new Set();
const brokerConnections = new Set();
const requestPagesByContext = new WeakMap();
let browserHooks = {
  loadPlaywright: () => import("playwright-core"),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stderr: (message) => process.stderr.write(`${message}\n`),
  sessionRoot: null,
  requestInPage: null,
};
let brokerHooks = {
  socketPath: null,
  spawnBroker: null,
};

function readBoundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function browserChannel() {
  const channel = String(process.env.LANHU_BROWSER_CHANNEL || "chrome").trim();
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`LANHU_BROWSER_CHANNEL 只允许: ${Array.from(ALLOWED_CHANNELS).join(", ")}`);
  }
  return channel;
}

function validateBrokerEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("蓝湖 API URL 无效。");
  }
  const paths = AUTHENTICATED_ENDPOINTS.get(parsed.origin);
  if (parsed.protocol !== "https:" || !paths?.has(parsed.pathname)) {
    throw new Error(`后台浏览器拒绝访问非白名单端点: ${parsed.origin}${parsed.pathname}`);
  }
  if (parsed.username || parsed.password) throw new Error("蓝湖 API URL 不能包含用户凭据。");
  return parsed;
}

function boundedBrokerInteger(value, label, fallback, minimum, maximum) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return candidate;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("蓝湖后台浏览器请求已取消。");
}

class BrowserRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserRequestError";
    this.code = code;
  }
}

async function interruptibleSleep(milliseconds, signal) {
  throwIfAborted(signal);
  if (!signal) return browserHooks.sleep(milliseconds);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new Error("蓝湖后台浏览器请求已取消。"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([browserHooks.sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function brokerRequestOptions(input = {}) {
  const headers = {};
  let headerBytes = 0;
  for (const [rawName, rawValue] of Object.entries(input.headers || {})) {
    const name = String(rawName);
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "proxy-authorization") {
      throw new Error("后台浏览器禁止客户端提供 Cookie 或代理凭据头。");
    }
    if (!BROKER_ALLOWED_REQUEST_HEADERS.has(lower)) {
      throw new Error(`蓝湖请求头不在白名单: ${name}`);
    }
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error("蓝湖请求头名称无效。");
    const value = String(rawValue);
    if (/\r|\n/.test(value)) throw new Error("蓝湖请求头值不能包含换行符。");
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 32 * 1024) throw new Error("蓝湖请求头超过大小限制。");
    headers[name] = value;
  }
  return {
    headers,
    label: "蓝湖 API ",
    loginTimeoutMs: boundedBrokerInteger(
      input.loginTimeoutMs,
      "loginTimeoutMs",
      DEFAULT_LOGIN_TIMEOUT_MS,
      30_000,
      15 * 60_000,
    ),
    maxBytes: boundedBrokerInteger(input.maxBytes, "maxBytes", 50 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxRedirects: boundedBrokerInteger(input.maxRedirects, "maxRedirects", 5, 0, 5),
    timeoutMs: boundedBrokerInteger(input.timeoutMs, "timeoutMs", 30_000, 1_000, 120_000),
    nonInteractive: input.nonInteractive === true,
    validateUrl: validateBrokerEndpoint,
  };
}

function fixedBrokerHeaders(url) {
  if (url.origin === "https://dds.lanhuapp.com") {
    return {
      "User-Agent": BROKER_USER_AGENT,
      Accept: "application/json, text/plain, */*",
      Referer: "https://dds.lanhuapp.com/",
      Authorization: "Basic dW5kZWZpbmVkOg==",
    };
  }
  return {
    "User-Agent": BROKER_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    Referer: "https://lanhuapp.com/web/",
    "request-from": "web",
    "real-path": "/item/project/product",
  };
}

async function ensurePrivateDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error(`浏览器会话目录不能是符号链接: ${directory}`);
    if (!info.isDirectory()) throw new Error(`浏览器会话路径不是目录: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function sessionRootDirectory() {
  const root = browserHooks.sessionRoot
    ? path.resolve(browserHooks.sessionRoot)
    : path.join(os.homedir(), ".lanhu-design-secure");
  await ensurePrivateDirectory(root);
  return root;
}

async function ensurePrivateSubdirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (!relative || relative === ".") return ensurePrivateDirectory(root);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("LANHU_BROWSER_PROFILE_DIR 必须位于蓝湖专用会话根目录中。");
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`浏览器会话目录不能包含符号链接: ${current}`);
      if (!info.isDirectory()) throw new Error(`浏览器会话路径不是目录: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
}

async function profileDirectory() {
  const defaultRoot = await sessionRootDirectory();
  const configured = String(process.env.LANHU_BROWSER_PROFILE_DIR || "").trim();
  const profile = configured
    ? path.resolve(configured)
    : path.join(defaultRoot, "browser-profile");
  const parsed = path.parse(profile);
  if (profile === parsed.root || profile === path.resolve(os.homedir())) {
    throw new Error("LANHU_BROWSER_PROFILE_DIR 不能指向文件系统根目录或用户主目录。");
  }
  const normalized = profile.replaceAll("\\", "/").toLowerCase();
  const browserProfileFragments = [
    "/library/application support/google/chrome",
    "/library/application support/microsoft edge",
    "/.config/google-chrome",
    "/.config/microsoft-edge",
    "/appdata/local/google/chrome/user data",
    "/appdata/local/microsoft/edge/user data",
  ];
  if (browserProfileFragments.some((fragment) => normalized.includes(fragment))) {
    throw new Error("LANHU_BROWSER_PROFILE_DIR 不能使用日常 Chrome/Edge 用户目录；请指定独立目录。");
  }
  await ensurePrivateSubdirectory(defaultRoot, profile);
  return profile;
}

async function browserBrokerSocketPath() {
  if (brokerHooks.socketPath) return brokerHooks.socketPath;
  const profile = await profileDirectory();
  const digest = createHash("sha256").update(profile).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lanhu-design-secure-${digest}`;
  }
  return path.join(await sessionRootDirectory(), `broker-${digest}.sock`);
}

async function browserBrokerStartupPath() {
  const socketPath = await browserBrokerSocketPath();
  const digest = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
  return path.join(await sessionRootDirectory(), `broker-${digest}.starting`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function parseBrokerStartupMarker(raw, markerPath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`蓝湖后台浏览器启动标记无效: ${markerPath}`);
  }
  const pid = Number(parsed?.pid);
  const startedAt = Number(parsed?.startedAt);
  const token = String(parsed?.token || "");
  if (!Number.isInteger(pid)
    || pid <= 0
    || !Number.isFinite(startedAt)
    || startedAt <= 0
    || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error(`蓝湖后台浏览器启动标记无效: ${markerPath}`);
  }
  return { pid, startedAt, token };
}

async function readBrokerStartupMarker(markerPath) {
  const info = await lstat(markerPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > BROKER_START_MARKER_MAX_BYTES) {
    throw new Error(`蓝湖后台浏览器启动标记不安全: ${markerPath}`);
  }
  return {
    info,
    ...parseBrokerStartupMarker(await readFile(markerPath, "utf8"), markerPath),
  };
}

async function brokerStartupState() {
  const markerPath = await browserBrokerStartupPath();
  try {
    const marker = await readBrokerStartupMarker(markerPath);
    const alive = processIsAlive(marker.pid);
    if (Date.now() - marker.startedAt > BROKER_START_MARKER_MAX_AGE_MS && !alive) {
      await unlink(markerPath);
      return null;
    }
    return { markerPath, ...marker, alive };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function clearBrokerStartupMarker(expectedToken = process.env.LANHU_BROKER_START_TOKEN || null) {
  const markerPath = await browserBrokerStartupPath();
  try {
    const marker = await readBrokerStartupMarker(markerPath);
    if (expectedToken && marker.token !== expectedToken) return false;
    await unlink(markerPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hasInitializedSession() {
  const profile = await profileDirectory();
  try {
    const info = await lstat(path.join(profile, ".lanhu-session-initialized-v1"));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function markInitializedSession() {
  const profile = await profileDirectory();
  const marker = path.join(profile, ".lanhu-session-initialized-v1");
  await mkdir(marker, { recursive: true, mode: 0o700 });
  const info = await lstat(marker);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`浏览器会话标记路径无效: ${marker}`);
  }
  await chmod(marker, 0o700);
}

function playwrightInstallHint() {
  const skillRoot = path.resolve(MODULE_DIR, "..");
  return `浏览器运行时尚未安装。请先运行: node "${path.join(skillRoot, "scripts", "install_browser_runtime.mjs")}"`;
}

async function loadChromium() {
  try {
    const playwright = await browserHooks.loadPlaywright();
    if (!playwright?.chromium) throw new Error("playwright-core 未提供 chromium。");
    return playwright.chromium;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || /playwright-core/.test(error.message)) {
      throw new Error(playwrightInstallHint());
    }
    throw error;
  }
}

async function launchContext(headless, signal = null, deadline = Number.POSITIVE_INFINITY) {
  throwIfAborted(signal);
  if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
  if (activeContext && activeHeadless === headless) return activeContext;
  if (browserLaunchPromise) {
    const launched = await browserLaunchPromise;
    throwIfAborted(signal);
    if (activeContext === launched && activeHeadless === headless) return launched;
  }

  const generation = browserGeneration;
  const launchTask = (async () => {
    await closeManagedBrowserSession();
    throwIfAborted(signal);
    if (brokerStopping || generation !== browserGeneration) {
      throw new Error("蓝湖后台浏览器正在停止。");
    }
    const chromium = await loadChromium();
    const profile = await profileDirectory();
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : 30_000;
    if (remaining <= 0) throw new Error("等待蓝湖登录超时。");
    let launchedContext = null;
    try {
      launchedContext = await chromium.launchPersistentContext(profile, {
        channel: browserChannel(),
        headless,
        timeout: Math.max(1, Math.min(30_000, remaining)),
        acceptDownloads: false,
        chromiumSandbox: true,
        ignoreHTTPSErrors: false,
        handleSIGHUP: true,
        handleSIGINT: true,
        handleSIGTERM: true,
        ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--no-sandbox"],
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-search-engine-choice-screen",
        ],
      });
      if (brokerStopping || generation !== browserGeneration || signal?.aborted) {
        await launchedContext.close().catch(() => {});
        throw new Error("蓝湖后台浏览器请求已取消。");
      }
      activeContext = launchedContext;
      activeHeadless = headless;
      if (typeof activeContext.on === "function") {
        activeContext.on("close", () => {
          if (activeContext === launchedContext) {
            activeContext = null;
            activeHeadless = null;
          }
        });
      }
      return activeContext;
    } catch (error) {
      if (activeContext === launchedContext) {
        activeContext = null;
        activeHeadless = null;
      }
      if (/请求已取消|正在停止|登录超时/.test(error.message)) throw error;
      if (/user data directory|ProcessSingleton|already in use|profile.*use/i.test(error.message)) {
        throw new Error("蓝湖专用浏览器会话正在被另一个进程使用。请关闭该专用窗口后重试。");
      }
      if (/executable|channel|chrome/i.test(error.message)) {
        throw new Error(`无法启动 ${browserChannel()}。请确认已安装 Chrome，或设置受支持的 LANHU_BROWSER_CHANNEL。`);
      }
      throw error;
    }
  })();
  browserLaunchPromise = launchTask;
  try {
    return await launchTask;
  } finally {
    if (browserLaunchPromise === launchTask) browserLaunchPromise = null;
  }
}

async function setBrowserWindowState(context, page, windowState) {
  if (!context || !page || page.isClosed?.()) return;
  if (typeof context.newCDPSession !== "function") return;
  try {
    const session = await context.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState },
    });
    await session.detach().catch(() => {});
  } catch {
    // Window management is best effort and never affects authentication.
  }
}

async function minimizeManagedBrowser(context) {
  const page = context?.pages?.()[0];
  await setBrowserWindowState(context, page, "minimized");
}

function evictRequestPage(context, origin, page) {
  const pages = requestPagesByContext.get(context);
  if (pages?.get(origin) === page) pages.delete(origin);
}

async function createPageWithinDeadline(context, signal, deadline, timeoutMessage) {
  throwIfAborted(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BrowserRequestError("timeout", timeoutMessage);
  const pagePromise = Promise.resolve().then(() => context.newPage());
  let timer = null;
  let onAbort = null;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserRequestError("timeout", timeoutMessage)),
      remaining,
    );
    if (signal) {
      onAbort = () => reject(new Error("蓝湖后台浏览器请求已取消。"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([pagePromise, interrupted]);
  } catch (error) {
    pagePromise.then((page) => page?.close?.().catch(() => {})).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function requestPageForOrigin(context, origin, deadline, signal) {
  let pages = requestPagesByContext.get(context);
  if (!pages) {
    pages = new Map();
    requestPagesByContext.set(context, pages);
  }
  const existing = pages.get(origin);
  if (existing && !existing.isClosed?.()) {
    try {
      if (new URL(existing.url()).origin === origin) return existing;
    } catch {
      // A crashed or unexpectedly navigated page is never reused.
    }
    evictRequestPage(context, origin, existing);
    await existing.close().catch(() => {});
  }
  const page = await createPageWithinDeadline(
    context,
    signal,
    deadline,
    "蓝湖认证请求超时。",
  );
  const abortPage = () => page.close().catch(() => {});
  signal?.addEventListener("abort", abortPage, { once: true });
  try {
    throwIfAborted(signal);
    const navigationRemaining = deadline - Date.now();
    if (navigationRemaining <= 0) {
      throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
    }
    await page.goto(`${origin}/`, {
      waitUntil: "domcontentloaded",
      timeout: navigationRemaining,
    });
    throwIfAborted(signal);
    if (new URL(page.url()).origin !== origin) {
      throw new Error("蓝湖认证页面跳转到其他域名，已拒绝继续请求。");
    }
    pages.set(origin, page);
    if (typeof page.once === "function") {
      page.once("close", () => evictRequestPage(context, origin, page));
      page.once("crash", () => evictRequestPage(context, origin, page));
    }
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    throwIfAborted(signal);
    if (error?.code === "timeout" || /跳转到其他域名/.test(error.message)) throw error;
    throw new BrowserRequestError("page_failure", "蓝湖认证请求页面初始化失败。");
  } finally {
    signal?.removeEventListener("abort", abortPage);
  }
}

async function streamResponseInPage(context, rawUrl, options) {
  const parsed = options.validateUrl(rawUrl);
  const deadline = options.deadline ?? (Date.now() + options.timeoutMs);
  const page = await requestPageForOrigin(
    context,
    parsed.origin,
    deadline,
    options.signal,
  );
  const abortPage = () => {
    evictRequestPage(context, parsed.origin, page);
    page.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortPage, { once: true });
  try {
    throwIfAborted(options.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
    const pageHeaders = {};
    let referrer = `${parsed.origin}/`;
    for (const [name, value] of Object.entries(options.headers)) {
      const lower = name.toLowerCase();
      if (lower === "referer") referrer = String(value);
      else if (lower !== "user-agent") pageHeaders[name] = value;
    }
    let streamed;
    try {
      streamed = await page.evaluate(async (input) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        let response;
        try {
          response = await fetch(input.url, {
            method: "GET",
            headers: input.headers,
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            referrer: input.referrer,
            signal: controller.signal,
          });
        } catch {
          return { error: controller.signal.aborted ? "timeout" : "network_or_redirect" };
        }
        const rawLength = response.headers.get("content-length");
        if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > input.maxBytes)) {
          await response.body?.cancel().catch(() => {});
          return { error: "too_large", declared: rawLength };
        }

        const reader = response.body?.getReader();
        let total = 0;
        let carry = new Uint8Array(0);
        const encoded = [];
        const encodeMultipleOfThree = (bytes) => {
          for (let offset = 0; offset < bytes.length; offset += 24_576) {
            const piece = bytes.subarray(offset, Math.min(bytes.length, offset + 24_576));
            let binary = "";
            for (let index = 0; index < piece.length; index += 1) {
              binary += String.fromCharCode(piece[index]);
            }
            encoded.push(btoa(binary));
          }
        };
        if (reader) {
          while (true) {
            let read;
            try {
              read = await reader.read();
            } catch {
              return { error: controller.signal.aborted ? "timeout" : "network_or_redirect" };
            }
            const { done, value } = read;
            if (done) break;
            total += value.byteLength;
            if (total > input.maxBytes) {
              controller.abort();
              await reader.cancel().catch(() => {});
              return { error: "too_large", received: total };
            }
            const combined = new Uint8Array(carry.length + value.length);
            combined.set(carry);
            combined.set(value, carry.length);
            const completeLength = combined.length - (combined.length % 3);
            if (completeLength > 0) encodeMultipleOfThree(combined.subarray(0, completeLength));
            carry = combined.slice(completeLength);
          }
        }
        if (carry.length > 0) {
          let binary = "";
          for (const byte of carry) binary += String.fromCharCode(byte);
          encoded.push(btoa(binary));
        }
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          bodyBase64: encoded.join(""),
        };
      } finally {
        clearTimeout(timer);
      }
      }, {
        url: parsed.href,
        headers: pageHeaders,
        referrer,
        maxBytes: options.maxBytes,
        timeoutMs: remaining,
      });
    } catch {
      throwIfAborted(options.signal);
      evictRequestPage(context, parsed.origin, page);
      await page.close().catch(() => {});
      throw new BrowserRequestError("page_failure", "蓝湖认证流式请求失败。");
    }
    throwIfAborted(options.signal);
    if (Date.now() >= deadline) {
      throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
    }
    if (streamed?.error === "too_large") {
      throw new Error(`响应体超过限制 ${options.maxBytes} 字节。`);
    }
    if (streamed?.error === "timeout") {
      throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
    }
    if (streamed?.error) {
      throw new BrowserRequestError("network_or_redirect", "蓝湖认证请求失败或发生重定向。");
    }
    const body = Buffer.from(String(streamed?.bodyBase64 || ""), "base64");
    if (body.length > options.maxBytes) throw new Error(`响应体超过限制 ${options.maxBytes} 字节。`);
    let data = null;
    try {
      data = JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      // Keep the bounded body only for authentication-failure classification.
    }
    return {
      status: Number(streamed.status),
      statusText: String(streamed.statusText || ""),
      headers: Object.fromEntries(
        (streamed.headers || []).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
      ),
      body,
      data,
    };
  } finally {
    options.signal?.removeEventListener("abort", abortPage);
  }
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function requestOnce(context, url, options) {
  throwIfAborted(options.signal);
  const deadline = Date.now() + options.timeoutMs;
  const attemptOptions = { ...options, deadline };
  for (const key of Object.keys(options.headers)) {
    if (key.toLowerCase() === "cookie") {
      throw new Error("浏览器会话模式禁止脚本读取或显式设置 Cookie 头。");
    }
  }
  let result;
  if (browserHooks.requestInPage) {
    result = await browserHooks.requestInPage(context, url, attemptOptions);
  } else {
    try {
      result = await streamResponseInPage(context, url, attemptOptions);
    } catch (error) {
      if (error?.code !== "page_failure") throw error;
      if (Date.now() >= deadline) {
        throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
      }
      result = await streamResponseInPage(context, url, attemptOptions);
    }
  }
  throwIfAborted(options.signal);
  if (Date.now() >= deadline) {
    throw new BrowserRequestError("timeout", "蓝湖认证请求超时。");
  }
  return result;
}

async function requestFollowingRedirects(context, initialUrl, options) {
  let current = String(initialUrl);
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const parsed = options.validateUrl(current);
    const result = await requestOnce(context, parsed.href, options);
    if (!isRedirect(result.status)) return result;
    if (redirects === options.maxRedirects) {
      throw new Error(`重定向次数超过 ${options.maxRedirects} 次。`);
    }
    const location = result.headers.location;
    if (!location) throw new Error(`HTTP ${result.status} 缺少 Location 头。`);
    const next = new URL(location, parsed);
    if (next.origin !== parsed.origin) {
      throw new Error("蓝湖认证请求试图跳转到其他域名，浏览器会话已拒绝跟随。");
    }
    current = options.validateUrl(next.href).href;
  }
  throw new Error("无法完成浏览器认证请求。");
}

function authenticationFailed(result) {
  if ([401, 403, 418].includes(result.status)) return true;
  const code = result.data?.code == null ? "" : String(result.data.code);
  if (AUTH_ERROR_CODES.has(code)) return true;
  const message = String(result.data?.msg || result.data?.message || "");
  if (/请.*登录|重新登录|登录.*失效|未登录|身份.*失效|认证.*失效|用户状态.*变化|login required|unauth/i.test(message)) return true;
  const contentType = result.headers["content-type"] || "";
  if (!result.data && /text\/html/i.test(contentType)) {
    const start = result.body.subarray(0, Math.min(result.body.length, 4096)).toString("utf8");
    return /登录|sign\s*in|login/i.test(start);
  }
  return false;
}

function assertJsonSuccess(result, label) {
  if (!result.data) {
    throw new Error(`${label}返回的不是有效 JSON (HTTP ${result.status})。`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label}HTTP ${result.status} ${result.statusText}`);
  }
  return result.data;
}

async function openLoginWindow(initialUrl, options) {
  if (options.nonInteractive) {
    throw new Error("蓝湖登录已失效；当前为非交互模式，无法打开登录窗口。");
  }

  const deadline = Date.now() + options.loginTimeoutMs;
  const context = await launchContext(false, options.signal, deadline);
  const pages = context.pages();
  const page = pages[0] || await createPageWithinDeadline(
    context,
    options.signal,
    deadline,
    "等待蓝湖登录超时。",
  );
  const abortLoginPage = () => {
    if (typeof page.close === "function") page.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", abortLoginPage, { once: true });
  try {
    throwIfAborted(options.signal);
    options.onLoginRequired?.();
    browserHooks.stderr("蓝湖登录窗口已打开。请在该专用窗口中正常登录；无需复制 Cookie。");
    const navigationRemaining = deadline - Date.now();
    if (navigationRemaining <= 0) throw new Error("等待蓝湖登录超时。");
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, Math.min(navigationRemaining, 60_000)),
    });
    throwIfAborted(options.signal);
    await setBrowserWindowState(context, page, "normal");
    await page.bringToFront();

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      if (page.isClosed()) throw new Error("蓝湖登录窗口已关闭，认证未完成。");
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const result = await requestFollowingRedirects(context, initialUrl, {
          ...options,
          timeoutMs: Math.max(1, Math.min(options.timeoutMs, remaining)),
        });
        if (!authenticationFailed(result)) {
          assertJsonSuccess(result, options.label);
          await markInitializedSession();
          browserHooks.stderr("蓝湖登录成功，会话已保存在专用浏览器配置中。");
          return context;
        }
      } catch (error) {
        if (/跳转到其他域名|非白名单|响应体|重定向次数/.test(error.message)) throw error;
        if (/closed|Target page|browser has been closed/i.test(error.message)) {
          throw new Error("蓝湖登录窗口已关闭，认证未完成。");
        }
        if (!["timeout", "network_or_redirect", "page_failure"].includes(error?.code)
          && !/timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|net::ERR|socket|network/i.test(error.message)) {
          throw error;
        }
        // The login page can transiently interrupt API requests while navigation completes.
      }
      const sleepRemaining = deadline - Date.now();
      if (sleepRemaining > 0) {
        await interruptibleSleep(Math.min(1_000, sleepRemaining), options.signal);
      }
    }
    throw new Error("等待蓝湖登录超时。请重新运行命令后在弹出的窗口中完成登录。");
  } finally {
    options.signal?.removeEventListener("abort", abortLoginPage);
  }
}

async function fetchLanhuJsonInBrowser(url, options, includeRaw = false) {
  const requestOptions = {
    ...options,
    loginTimeoutMs: options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? 5,
    nonInteractive: options.nonInteractive ?? String(process.env.LANHU_NONINTERACTIVE || "") === "1",
  };
  let context;
  let result;
  if (!await hasInitializedSession()) {
    context = await openLoginWindow(url, requestOptions);
  } else {
    context = activeContext || await launchContext(
      false,
      requestOptions.signal,
      Date.now() + requestOptions.loginTimeoutMs,
    );
  }
  result = await requestFollowingRedirects(context, url, requestOptions);
  if (authenticationFailed(result)) {
    context = await openLoginWindow(url, requestOptions);
    result = await requestFollowingRedirects(context, url, requestOptions);
    if (authenticationFailed(result)) {
      throw new Error("蓝湖登录完成后仍未获得项目访问权限。");
    }
  }
  const data = assertJsonSuccess(result, requestOptions.label);
  await minimizeManagedBrowser(context);
  return includeRaw ? { data, body: result.body } : data;
}

async function closeManagedBrowserSession() {
  const context = activeContext;
  activeContext = null;
  activeHeadless = null;
  if (context) await context.close().catch(() => {});
}

function brokerMessage(action, fields = {}) {
  return {
    protocol: BROKER_PROTOCOL_VERSION,
    action,
    ...fields,
  };
}

function sendBrokerMessage(
  socketPath,
  message,
  timeoutMs,
  maxResponseBytes = BROKER_MAX_MESSAGE_BYTES,
  onEvent = () => {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let frameChunks = [];
    let receivedBytes = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > maxResponseBytes) {
        finish(new Error("蓝湖后台浏览器响应超过大小限制。"));
        return;
      }
      let start = 0;
      let newline = chunk.indexOf("\n", start);
      while (newline !== -1 && !settled) {
        frameChunks.push(chunk.slice(start, newline));
        const line = frameChunks.join("");
        frameChunks = [];
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event) onEvent(parsed);
          else finish(null, parsed);
        } catch {
          finish(new Error("蓝湖后台浏览器返回了无效响应。"));
        }
        start = newline + 1;
        newline = chunk.indexOf("\n", start);
      }
      if (!settled && start < chunk.length) frameChunks.push(chunk.slice(start));
    });
    socket.once("timeout", () => finish(new Error("等待蓝湖后台浏览器响应超时。")));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("蓝湖后台浏览器在返回结果前关闭了连接。"));
    });
  });
}

async function probeBroker(socketPath, timeoutMs = 1_000) {
  const response = await sendBrokerMessage(
    socketPath,
    brokerMessage("ping"),
    timeoutMs,
    64 * 1024,
  );
  if (!response?.ok || response.protocol !== BROKER_PROTOCOL_VERSION) {
    throw new Error("蓝湖后台浏览器协议版本不匹配。请先停止旧会话。 ");
  }
  return response;
}

async function socketAcceptsConnections(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function prepareBrokerSocket(socketPath) {
  if (process.platform === "win32") return;
  try {
    const info = await lstat(socketPath);
    if (info.isSymbolicLink() || !info.isSocket()) {
      throw new Error(`蓝湖后台浏览器 Socket 路径不安全: ${socketPath}`);
    }
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error("蓝湖后台浏览器已经在运行。");
    }
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function initiateBrokerShutdown() {
  if (brokerStopping) return;
  brokerStopping = true;
  browserGeneration += 1;
  for (const controller of brokerRequestControllers) controller.abort();
}

async function handleBrokerMessage(message, notify = () => {}, controller = null) {
  if (!message || message.protocol !== BROKER_PROTOCOL_VERSION) {
    throw new Error("蓝湖后台浏览器协议版本无效。");
  }
  if (message.action === "ping") {
    return {
      ok: true,
      protocol: BROKER_PROTOCOL_VERSION,
      status: brokerStopping ? "stopping" : (activeBrokerRequestController ? "busy" : "running"),
    };
  }
  if (message.action === "request") {
    if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
    throwIfAborted(controller?.signal);
    const parsedUrl = validateBrokerEndpoint(message.url);
    const url = parsedUrl.href;
    const options = brokerRequestOptions(message.options);
    options.headers = fixedBrokerHeaders(parsedUrl);
    options.label = parsedUrl.origin === "https://dds.lanhuapp.com" ? "DDS " : "蓝湖 API ";
    options.onLoginRequired = () => notify({
      protocol: BROKER_PROTOCOL_VERSION,
      event: "login_required",
    });
    options.signal = controller?.signal;
    activeBrokerRequestController = controller;
    try {
      const result = await fetchLanhuJsonInBrowser(url, options, true);
      return {
        ok: true,
        protocol: BROKER_PROTOCOL_VERSION,
        bodyBase64: result.body.toString("base64"),
      };
    } finally {
      if (activeBrokerRequestController === controller) activeBrokerRequestController = null;
    }
  }
  if (message.action === "shutdown") {
    initiateBrokerShutdown();
    setTimeout(() => {
      stopBrowserBrokerServer().catch(() => {});
    }, 25);
    return { ok: true, protocol: BROKER_PROTOCOL_VERSION, status: "stopping" };
  }
  throw new Error("蓝湖后台浏览器不支持该操作。");
}

function handleBrokerConnection(socket) {
  if (brokerConnections.size >= BROKER_MAX_CONNECTIONS) {
    socket.destroy();
    return;
  }
  brokerConnections.add(socket);
  socket.setEncoding("utf8");
  socket.setTimeout(BROKER_IDLE_CLIENT_TIMEOUT_MS, () => socket.destroy());
  const connectionDeadline = setTimeout(() => socket.destroy(), BROKER_IDLE_CLIENT_TIMEOUT_MS);
  let received = "";
  let handled = false;
  let requestController = null;
  const release = () => {
    clearTimeout(connectionDeadline);
    brokerConnections.delete(socket);
    requestController?.abort();
  };
  socket.once("close", release);
  socket.once("end", () => {
    if (!handled) socket.destroy();
  });
  socket.on("data", (chunk) => {
    if (handled) return;
    received += chunk;
    if (Buffer.byteLength(received) > BROKER_MAX_REQUEST_BYTES) {
      handled = true;
      socket.end(`${JSON.stringify({ ok: false, protocol: BROKER_PROTOCOL_VERSION, error: "请求超过大小限制。" })}\n`);
      return;
    }
    const newline = received.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    clearTimeout(connectionDeadline);
    socket.setTimeout(0);
    let message;
    try {
      message = JSON.parse(received.slice(0, newline));
    } catch {
      socket.end(`${JSON.stringify({ ok: false, protocol: BROKER_PROTOCOL_VERSION, error: "请求 JSON 无效。" })}\n`);
      return;
    }
    const notify = (event) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
    };
    let task;
    if (message.action === "ping" || message.action === "shutdown") {
      task = handleBrokerMessage(message, notify);
    } else if (brokerQueuedRequests >= BROKER_MAX_QUEUED_REQUESTS) {
      task = Promise.reject(new Error("蓝湖后台浏览器请求队列已满。"));
    } else {
      requestController = new AbortController();
      brokerRequestControllers.add(requestController);
      brokerQueuedRequests += 1;
      task = brokerQueue.then(() => handleBrokerMessage(message, notify, requestController));
      brokerQueue = task.catch(() => {});
      task.finally(() => {
        brokerRequestControllers.delete(requestController);
        brokerQueuedRequests = Math.max(0, brokerQueuedRequests - 1);
      }).catch(() => {});
    }
    task.then(
      (response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      },
      (error) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify({
        ok: false,
        protocol: BROKER_PROTOCOL_VERSION,
        error: String(error?.message || "蓝湖后台浏览器请求失败。"),
        })}\n`);
      },
    );
  });
  socket.on("error", () => socket.destroy());
}

async function startBrowserBrokerServer() {
  if (brokerServer) return brokerServer;
  if (brokerStartPromise) return brokerStartPromise;
  if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
  const startTask = (async () => {
    const socketPath = await browserBrokerSocketPath();
    if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
    await prepareBrokerSocket(socketPath);
    if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
    const server = net.createServer(handleBrokerConnection);
    brokerServer = server;
    brokerServerSocket = socketPath;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
      if (brokerStopping) throw new Error("蓝湖后台浏览器正在停止。");
      if (process.platform !== "win32") await chmod(socketPath, 0o600);
      await clearBrokerStartupMarker();
      return server;
    } catch (error) {
      if (server.listening) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
      if (brokerServer === server) brokerServer = null;
      if (brokerServerSocket === socketPath) brokerServerSocket = null;
      await clearBrokerStartupMarker().catch(() => {});
      throw error;
    }
  })();
  brokerStartPromise = startTask;
  try {
    return await startTask;
  } finally {
    if (brokerStartPromise === startTask) brokerStartPromise = null;
  }
}

async function stopBrowserBrokerServer() {
  initiateBrokerShutdown();
  if (brokerShutdownPromise) return brokerShutdownPromise;
  const shutdownTask = (async () => {
    await brokerStartPromise?.catch(() => {});
    await browserLaunchPromise?.catch(() => {});
    const server = brokerServer;
    const socketPath = brokerServerSocket;
    brokerServer = null;
    brokerServerSocket = null;
    activeBrokerRequestController = null;
    await closeManagedBrowserSession();
    for (const socket of brokerConnections) socket.destroy();
    brokerConnections.clear();
    brokerRequestControllers.clear();
    if (server?.listening) {
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    }
    if (socketPath && process.platform !== "win32") {
      try {
        const info = await lstat(socketPath);
        if (!info.isSymbolicLink() && info.isSocket()) await unlink(socketPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    brokerQueue = Promise.resolve();
    brokerQueuedRequests = 0;
  })();
  brokerShutdownPromise = shutdownTask;
  try {
    return await shutdownTask;
  } finally {
    if (brokerShutdownPromise === shutdownTask) brokerShutdownPromise = null;
  }
}

function spawnBrowserBrokerProcess(startToken) {
  if (brokerHooks.spawnBroker) return brokerHooks.spawnBroker(startToken);
  const environment = browserBrokerEnvironment(startToken);
  const child = spawn(
    process.execPath,
    [path.join(MODULE_DIR, "browser-broker.mjs"), "--serve"],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return child.pid;
}

async function spawnBrowserBrokerOnce() {
  const markerPath = await browserBrokerStartupPath();
  const token = randomBytes(32).toString("hex");
  const temporaryMarkerPath = `${markerPath}.${token}.tmp`;
  const startedAt = Date.now();
  const markerPayload = (pid) => `${JSON.stringify({
    pid: String(pid).padStart(20, "0"),
    startedAt,
    token,
  })}\n`;
  let marker;
  let claimed = false;
  try {
    marker = await open(temporaryMarkerPath, "wx", 0o600);
    await marker.write(markerPayload(process.pid), 0, "utf8");
    await marker.sync();
    try {
      await link(temporaryMarkerPath, markerPath);
      claimed = true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    await unlink(temporaryMarkerPath);
    const pid = Number(spawnBrowserBrokerProcess(token));
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("蓝湖后台浏览器进程未返回有效 PID。");
    }
    await marker.write(markerPayload(pid), 0, "utf8");
    await marker.sync();
    return true;
  } catch (error) {
    if (claimed) await clearBrokerStartupMarker(token).catch(() => {});
    throw error;
  } finally {
    await marker?.close().catch(() => {});
    await unlink(temporaryMarkerPath).catch(() => {});
  }
}

function browserBrokerEnvironment(startToken = null) {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "__CF_USER_TEXT_ENCODING",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "LANHU_BROWSER_CHANNEL",
    "LANHU_BROWSER_PROFILE_DIR",
  ];
  const environment = {};
  for (const name of allowed) {
    if (process.env[name] != null && process.env[name] !== "") {
      environment[name] = process.env[name];
    }
  }
  environment.LANHU_AUTH_MODE = "browser";
  if (startToken) environment.LANHU_BROKER_START_TOKEN = startToken;
  return environment;
}

async function ensureBrowserBroker() {
  const socketPath = await browserBrokerSocketPath();
  try {
    await probeBroker(socketPath);
    return socketPath;
  } catch {
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error("蓝湖后台浏览器正在运行但管理接口未响应；已拒绝启动重复代理。");
    }
    if (!await brokerStartupState()) await spawnBrowserBrokerOnce();
  }
  const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await browserHooks.sleep(100);
      await probeBroker(socketPath);
      return socketPath;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法启动蓝湖后台浏览器: ${lastError?.message || "启动超时"}`);
}

export async function fetchLanhuJsonWithBrowser(url, options = {}) {
  const parsed = validateBrokerEndpoint(url);
  const validated = brokerRequestOptions({
    ...options,
    nonInteractive: String(process.env.LANHU_NONINTERACTIVE || "") === "1",
  });
  const serializableOptions = {
    headers: validated.headers,
    loginTimeoutMs: validated.loginTimeoutMs,
    maxBytes: validated.maxBytes,
    maxRedirects: validated.maxRedirects,
    timeoutMs: validated.timeoutMs,
    nonInteractive: validated.nonInteractive,
  };
  const socketPath = await ensureBrowserBroker();
  const response = await sendBrokerMessage(
    socketPath,
    brokerMessage("request", { url: parsed.href, options: serializableOptions }),
    validated.loginTimeoutMs + validated.timeoutMs + 30_000,
    Math.min(
      BROKER_MAX_MESSAGE_BYTES,
      (Math.ceil(validated.maxBytes / 3) * 4) + (64 * 1024),
    ),
    (event) => {
      if (event.event === "login_required") {
        browserHooks.stderr("蓝湖登录窗口已打开。请在该专用窗口中正常登录；无需复制 Cookie。");
      }
    },
  );
  if (!response?.ok) throw new Error(response?.error || "蓝湖后台浏览器请求失败。");
  if (typeof response.bodyBase64 !== "string"
    || response.bodyBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.bodyBase64)) {
    throw new Error("蓝湖后台浏览器返回了无效响应体。");
  }
  const body = Buffer.from(response.bodyBase64, "base64");
  if (body.length > validated.maxBytes) {
    throw new Error(`响应体超过限制 ${validated.maxBytes} 字节。`);
  }
  try {
    return JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("蓝湖后台浏览器返回的不是有效 JSON。");
  }
}

export async function closeBrowserSession() {
  // Commands close only their IPC connection. The local broker owns the browser session.
}

export async function browserBrokerStatus() {
  const socketPath = await browserBrokerSocketPath();
  try {
    const response = await probeBroker(socketPath);
    return ["running", "busy", "stopping"].includes(response?.status) ? response.status : "incompatible";
  } catch (error) {
    if (!await socketAcceptsConnections(socketPath)) {
      return await brokerStartupState() ? "starting" : "stopped";
    }
    return /协议版本不匹配/.test(error.message) ? "incompatible" : "unresponsive";
  }
}

export async function stopBrowserBroker() {
  const socketPath = await browserBrokerSocketPath();
  const deadline = Date.now() + 35_000;
  let response;
  while (Date.now() < deadline) {
    try {
      response = await sendBrokerMessage(
        socketPath,
        brokerMessage("shutdown"),
        5_000,
        64 * 1024,
      );
      break;
    } catch (error) {
      if (await socketAcceptsConnections(socketPath)) {
        return { status: "stop_failed", error: String(error.message || "管理接口无响应。") };
      }
      if (!await brokerStartupState()) return { status: "stopped" };
      await browserHooks.sleep(100);
    }
  }
  if (!response) return { status: "stop_failed", error: "蓝湖后台浏览器仍在启动，未能确认停止。" };
  if (!response?.ok || response.protocol !== BROKER_PROTOCOL_VERSION) {
    return { status: "stop_failed", error: "蓝湖后台浏览器未确认停止请求。" };
  }
  while (Date.now() < deadline) {
    await browserHooks.sleep(100);
    try {
      const probe = await probeBroker(socketPath, 500);
      if (["running", "busy"].includes(probe?.status)) {
        response = await sendBrokerMessage(
          socketPath,
          brokerMessage("shutdown"),
          5_000,
          64 * 1024,
        );
        if (!response?.ok || response.protocol !== BROKER_PROTOCOL_VERSION) {
          return { status: "stop_failed", error: "蓝湖后台浏览器未确认停止请求。" };
        }
      }
    } catch {
      if (!await socketAcceptsConnections(socketPath) && !await brokerStartupState()) {
        return { status: "stopped" };
      }
    }
  }
  return { status: "stop_failed", error: "蓝湖后台浏览器未在时限内停止。" };
}

export async function runBrowserBroker() {
  const server = await startBrowserBrokerServer();
  if (brokerStopping) {
    await stopBrowserBrokerServer();
    return;
  }
  return new Promise((resolve) => server.once("close", resolve));
}

export async function shutdownBrowserBrokerServer() {
  return stopBrowserBrokerServer();
}

export async function __fetchLanhuJsonInBrowserForTests(url, options) {
  if (process.env.NODE_ENV !== "test") throw new Error("测试浏览器入口仅允许在 NODE_ENV=test 时使用。");
  return fetchLanhuJsonInBrowser(url, options);
}

export async function __browserBrokerStartupPathForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试启动标记入口仅允许在 NODE_ENV=test 时使用。");
  return browserBrokerStartupPath();
}

export function __setBrokerHooksForTests(hooks) {
  if (process.env.NODE_ENV !== "test") throw new Error("测试代理钩子仅允许在 NODE_ENV=test 时设置。");
  brokerHooks = { ...brokerHooks, ...hooks };
}

export function __browserBrokerEnvironmentForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试代理环境入口仅允许在 NODE_ENV=test 时使用。");
  return browserBrokerEnvironment();
}

export async function __startBrowserBrokerForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试代理入口仅允许在 NODE_ENV=test 时使用。");
  brokerStopping = false;
  browserGeneration += 1;
  await startBrowserBrokerServer();
}

export async function __stopBrowserBrokerForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试代理入口仅允许在 NODE_ENV=test 时使用。");
  await stopBrowserBrokerServer();
  brokerStopping = false;
  browserGeneration += 1;
}

export function __resetBrokerHooksForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试代理钩子仅允许在 NODE_ENV=test 时重置。");
  brokerHooks = { socketPath: null, spawnBroker: null };
}

export function __setBrowserHooksForTests(hooks) {
  if (process.env.NODE_ENV !== "test") throw new Error("测试浏览器钩子仅允许在 NODE_ENV=test 时设置。");
  browserHooks = { ...browserHooks, ...hooks };
}

export function __resetBrowserHooksForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试浏览器钩子仅允许在 NODE_ENV=test 时重置。");
  browserHooks = {
    loadPlaywright: () => import("playwright-core"),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stderr: (message) => process.stderr.write(`${message}\n`),
    sessionRoot: null,
    requestInPage: null,
  };
}

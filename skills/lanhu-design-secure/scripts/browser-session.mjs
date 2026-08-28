#!/usr/bin/env node

import { chmod, lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOGIN_URL = "https://lanhuapp.com/web/";
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

let activeContext = null;
let activeHeadless = null;
let browserHooks = {
  loadPlaywright: () => import("playwright-core"),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stderr: (message) => process.stderr.write(`${message}\n`),
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

async function profileDirectory() {
  const defaultRoot = path.join(os.homedir(), ".lanhu-design-secure");
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
  if (!configured) await ensurePrivateDirectory(defaultRoot);
  await ensurePrivateDirectory(profile);
  return profile;
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
  const skillRoot = path.resolve(import.meta.dirname, "..");
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

async function launchContext(headless) {
  if (activeContext && activeHeadless === headless) return activeContext;
  await closeBrowserSession();
  const chromium = await loadChromium();
  const profile = await profileDirectory();
  try {
    activeContext = await chromium.launchPersistentContext(profile, {
      channel: browserChannel(),
      headless,
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      handleSIGHUP: true,
      handleSIGINT: true,
      handleSIGTERM: true,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
      ],
    });
    activeHeadless = headless;
    return activeContext;
  } catch (error) {
    activeContext = null;
    activeHeadless = null;
    if (/user data directory|ProcessSingleton|already in use|profile.*use/i.test(error.message)) {
      throw new Error("蓝湖专用浏览器会话正在被另一个进程使用。请关闭该专用窗口后重试。");
    }
    if (/executable|channel|chrome/i.test(error.message)) {
      throw new Error(`无法启动 ${browserChannel()}。请确认已安装 Chrome，或设置受支持的 LANHU_BROWSER_CHANNEL。`);
    }
    throw error;
  }
}

function responseHeaders(response) {
  const headers = response.headers();
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

async function readResponse(response, maxBytes) {
  const headers = responseHeaders(response);
  const status = response.status();
  const statusText = response.statusText();
  const declared = Number.parseInt(headers["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.dispose().catch(() => {});
    throw new Error(`响应体 ${declared} 字节超过限制 ${maxBytes} 字节。`);
  }
  const body = await response.body();
  await response.dispose().catch(() => {});
  if (body.length > maxBytes) {
    throw new Error(`响应体超过限制 ${maxBytes} 字节。`);
  }
  let data = null;
  try {
    data = JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    // Authentication redirects can return HTML. Keep the bounded body only for classification.
  }
  return {
    status,
    statusText,
    headers,
    body,
    data,
  };
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function requestOnce(context, url, options) {
  const headers = { ...options.headers };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "cookie") {
      throw new Error("浏览器会话模式禁止脚本读取或显式设置 Cookie 头。");
    }
  }
  const response = await context.request.get(url, {
    headers,
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: options.timeoutMs,
  });
  return readResponse(response, options.maxBytes);
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
  if (String(process.env.LANHU_NONINTERACTIVE || "") === "1") {
    throw new Error("蓝湖登录已失效；当前为非交互模式，无法打开登录窗口。");
  }

  const context = await launchContext(false);
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  browserHooks.stderr("蓝湖登录窗口已打开。请在该专用窗口中正常登录；无需复制 Cookie。");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: Math.min(options.loginTimeoutMs, 60_000),
  });
  await page.bringToFront();

  const deadline = Date.now() + options.loginTimeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("蓝湖登录窗口已关闭，认证未完成。");
    try {
      const result = await requestFollowingRedirects(context, initialUrl, options);
      if (!authenticationFailed(result)) {
        assertJsonSuccess(result, options.label);
        await markInitializedSession();
        browserHooks.stderr("蓝湖登录成功，会话已保存在专用浏览器配置中。");
        return;
      }
    } catch (error) {
      if (/跳转到其他域名|非白名单|响应体|重定向次数/.test(error.message)) throw error;
      if (/closed|Target page|browser has been closed/i.test(error.message)) {
        throw new Error("蓝湖登录窗口已关闭，认证未完成。");
      }
      if (!/timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|net::ERR|socket|network/i.test(error.message)) {
        throw error;
      }
      // The login page can transiently interrupt API requests while navigation completes.
    }
    await browserHooks.sleep(1_000);
  }
  throw new Error("等待蓝湖登录超时。请重新运行命令后在弹出的窗口中完成登录。");
}

export async function fetchLanhuJsonWithBrowser(url, options) {
  const requestOptions = {
    ...options,
    loginTimeoutMs: options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? 5,
  };
  let context;
  let result;
  if (!await hasInitializedSession()) {
    await openLoginWindow(url, requestOptions);
    await closeBrowserSession();
  }
  context = await launchContext(true);
  result = await requestFollowingRedirects(context, url, requestOptions);
  if (authenticationFailed(result)) {
    await closeBrowserSession();
    await openLoginWindow(url, requestOptions);
    await closeBrowserSession();
    context = await launchContext(true);
    result = await requestFollowingRedirects(context, url, requestOptions);
    if (authenticationFailed(result)) {
      throw new Error("蓝湖登录完成后仍未获得项目访问权限。");
    }
  }
  return assertJsonSuccess(result, requestOptions.label);
}

export async function closeBrowserSession() {
  const context = activeContext;
  activeContext = null;
  activeHeadless = null;
  if (context) await context.close().catch(() => {});
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
  };
}

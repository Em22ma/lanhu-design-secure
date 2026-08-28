#!/usr/bin/env node

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const MiB = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = readBoundedInteger("LANHU_HTTP_TIMEOUT_MS", 30_000, 1_000, 120_000);
const DEFAULT_JSON_LIMIT = readBoundedInteger("LANHU_MAX_JSON_BYTES", 50 * MiB, MiB, 100 * MiB);
const DEFAULT_ASSET_LIMIT = readBoundedInteger("LANHU_MAX_ASSET_BYTES", 32 * MiB, MiB, 100 * MiB);
const MAX_REDIRECTS = 5;
const TRUSTED_RESOURCE_SUFFIXES = ["lanhuapp.com", "aliyuncs.com"];
const EXTRA_RESOURCE_HOSTS = new Set(
  String(process.env.LANHU_ASSET_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

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

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json, text/plain, */*",
};

let networkHooks = {
  fetch: (...args) => globalThis.fetch(...args),
  lookup: (...args) => dnsLookup(...args),
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

function getCookie() {
  const cookie = process.env.LANHU_COOKIE;
  if (!cookie || cookie === "your_lanhu_cookie_here") {
    throw new Error(
      "LANHU_COOKIE 环境变量未设置。请使用只读蓝湖账号的临时会话 Cookie，并仅向当前命令注入。",
    );
  }
  return cookie;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

async function assertPublicHttpsUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("资源 URL 无效。");
  }
  if (parsed.protocol !== "https:") throw new Error("资源 URL 必须使用 HTTPS。");
  if (parsed.username || parsed.password) throw new Error("资源 URL 不能包含用户凭据。");
  if (!parsed.hostname) throw new Error("资源 URL 缺少主机名。");
  const hostname = parsed.hostname.toLowerCase();
  const trusted = TRUSTED_RESOURCE_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  ) || EXTRA_RESOURCE_HOSTS.has(hostname);
  if (!trusted) {
    throw new Error(
      `资源主机 ${hostname} 不在白名单。确认它属于当前蓝湖项目后，可通过 LANHU_ASSET_HOSTS 追加这个精确主机名。`,
    );
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("拒绝访问私有、回环或保留 IP 地址。");
    return parsed;
  }

  let addresses;
  try {
    addresses = await networkHooks.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`无法解析资源主机 ${hostname}: ${error.message}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`资源主机 ${hostname} 没有可用地址。`);
  }
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error(`资源主机 ${hostname} 解析到私有、回环或保留地址。`);
  }
  return parsed;
}

function assertAuthenticatedEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("蓝湖 API URL 无效。");
  }
  const paths = AUTHENTICATED_ENDPOINTS.get(parsed.origin);
  if (parsed.protocol !== "https:" || !paths?.has(parsed.pathname)) {
    throw new Error(`拒绝向非白名单端点发送蓝湖 Cookie: ${parsed.origin}${parsed.pathname}`);
  }
  if (parsed.username || parsed.password) throw new Error("蓝湖 API URL 不能包含用户凭据。");
  return parsed;
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchFollowingRedirects(initialUrl, options) {
  let current = String(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const parsed = options.authenticated
      ? assertAuthenticatedEndpoint(current)
      : await assertPublicHttpsUrl(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response;
    try {
      response = await networkHooks.fetch(parsed, {
        method: "GET",
        headers: options.headers(parsed),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
    if (!isRedirect(response.status)) {
      return {
        response,
        cleanup: () => {
          clearTimeout(timeout);
          controller.abort();
        },
      };
    }
    clearTimeout(timeout);
    if (redirects === MAX_REDIRECTS) throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次。`);
    const location = response.headers.get("location");
    if (!location) throw new Error(`HTTP ${response.status} 缺少 Location 头。`);
    const next = new URL(location, parsed);
    if (options.authenticated && next.origin !== parsed.origin) {
      throw new Error("蓝湖认证请求试图跳转到其他域名，已拒绝并阻止 Cookie 泄露。");
    }
    current = next.href;
  }
  throw new Error("无法完成网络请求。");
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`响应体 ${declared} 字节超过限制 ${maxBytes} 字节。`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      if (typeof response.body.cancel === "function") await response.body.cancel().catch(() => {});
      throw new Error(`响应体超过限制 ${maxBytes} 字节。`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function assertOk(response, label) {
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label}认证失败 (HTTP ${response.status})。LANHU_COOKIE 可能已过期。`);
  }
  if (!response.ok) throw new Error(`${label}HTTP ${response.status} ${response.statusText}`);
}

function looksLikeImage(buffer, contentType) {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return true;
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true;
  const textStart = buffer.subarray(0, Math.min(buffer.length, 2048)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if ((type === "image/svg+xml" || type === "text/xml" || type === "application/xml") && /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(textStart)) return true;
  return false;
}

export async function fetchLanhuJson(url, { dds = false } = {}) {
  const { response, cleanup } = await fetchFollowingRedirects(url, {
    authenticated: true,
    headers: () => ({
      ...COMMON_HEADERS,
      Cookie: getCookie(),
      Referer: dds ? "https://dds.lanhuapp.com/" : "https://lanhuapp.com/web/",
      ...(dds ? { Authorization: "Basic dW5kZWZpbmVkOg==" } : {
        "request-from": "web",
        "real-path": "/item/project/product",
      }),
    }),
  });
  try {
    assertOk(response, dds ? "DDS " : "");
    const buffer = await readLimitedBody(response, DEFAULT_JSON_LIMIT);
    try {
      return JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("蓝湖 API 返回的不是有效 JSON。");
    }
  } finally {
    cleanup();
  }
}

export async function fetchResourceJson(url) {
  const { response, cleanup } = await fetchFollowingRedirects(url, {
    authenticated: false,
    headers: () => ({ ...COMMON_HEADERS }),
  });
  try {
    assertOk(response, "资源 ");
    const buffer = await readLimitedBody(response, DEFAULT_JSON_LIMIT);
    try {
      return JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("资源响应不是有效 JSON。");
    }
  } finally {
    cleanup();
  }
}

export async function fetchImageBytes(url, { referer = "" } = {}) {
  let safeReferer = "";
  if (referer) {
    const parsedReferer = new URL(referer);
    if (parsedReferer.protocol !== "https:" || !["lanhuapp.com", "dds.lanhuapp.com"].includes(parsedReferer.hostname)) {
      throw new Error("Referer 只能使用蓝湖 HTTPS 域名。");
    }
    safeReferer = parsedReferer.href;
  }
  const { response, cleanup } = await fetchFollowingRedirects(url, {
    authenticated: false,
    headers: () => ({
      "User-Agent": COMMON_HEADERS["User-Agent"],
      Accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
      ...(safeReferer ? { Referer: safeReferer } : {}),
    }),
  });
  try {
    assertOk(response, "资源 ");
    const buffer = await readLimitedBody(response, DEFAULT_ASSET_LIMIT);
    const contentType = response.headers.get("content-type") || "";
    if (!looksLikeImage(buffer, contentType)) {
      throw new Error(`资源不是受支持的图片类型 (Content-Type: ${contentType || "missing"})。`);
    }
    return { buffer, contentType, finalUrl: response.url || String(url) };
  } finally {
    cleanup();
  }
}

export function __setNetworkHooksForTests(hooks) {
  if (process.env.NODE_ENV !== "test") throw new Error("测试网络钩子仅允许在 NODE_ENV=test 时设置。");
  networkHooks = {
    fetch: hooks.fetch || networkHooks.fetch,
    lookup: hooks.lookup || networkHooks.lookup,
  };
}

export function __resetNetworkHooksForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试网络钩子仅允许在 NODE_ENV=test 时重置。");
  networkHooks = {
    fetch: (...args) => globalThis.fetch(...args),
    lookup: (...args) => dnsLookup(...args),
  };
}

#!/usr/bin/env node

import {
  Resolver as DnsResolver,
} from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import {
  closeBrowserSession,
  fetchLanhuJsonWithBrowser,
} from "./browser-session.mjs";

const MiB = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = readBoundedInteger("LANHU_HTTP_TIMEOUT_MS", 30_000, 1_000, 120_000);
const DEFAULT_JSON_LIMIT = readBoundedInteger("LANHU_MAX_JSON_BYTES", 50 * MiB, MiB, 100 * MiB);
const DEFAULT_ASSET_LIMIT = readBoundedInteger("LANHU_MAX_ASSET_BYTES", 32 * MiB, MiB, 100 * MiB);
const MAX_REDIRECTS = 5;
const MAX_DECODED_PIXELS = 40_000_000;
const MAX_IMAGE_FRAMES = 100;
const MAX_DECODED_IMAGE_BYTES = MAX_DECODED_PIXELS * 4;
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
  publicFetch: pinnedPublicFetch,
  createResolver: () => new DnsResolver(),
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
      "LANHU_AUTH_MODE=cookie 需要 LANHU_COOKIE；推荐移除该配置并使用托管浏览器会话。",
    );
  }
  return cookie;
}

function authenticationMode() {
  const configured = String(process.env.LANHU_AUTH_MODE || "").trim().toLowerCase();
  if (configured && !["browser", "cookie"].includes(configured)) {
    throw new Error("LANHU_AUTH_MODE 只允许 browser 或 cookie。");
  }
  return configured || "browser";
}

function isPrivateIp(address) {
  try {
    let parsed = ipaddr.parse(String(address).split("%", 1)[0]);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() !== "unicast";
  } catch {
    return true;
  }
}

function timeoutError(timeoutMs) {
  const error = new Error(`网络请求超过 ${timeoutMs} 毫秒，已终止。`);
  error.code = "LANHU_HTTP_TIMEOUT";
  return error;
}

function awaitUntil(promise, { signal, deadline, timeoutMessage = "操作超时。" }) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error(timeoutMessage));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(timeoutMessage));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason || new Error(timeoutMessage));
    const timer = Number.isFinite(remaining)
      ? setTimeout(() => finish(reject, new Error(timeoutMessage)), remaining)
      : null;
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function normalizePublicAddresses(hostname, addresses, family = 0) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`资源主机 ${hostname} 没有可用地址。`);
  }
  const normalized = addresses.map((entry) => ({
    address: String(typeof entry === "string" ? entry : entry.address),
    family: Number(typeof entry === "string" ? family : entry.family)
      || net.isIP(String(typeof entry === "string" ? entry : entry.address)),
  }));
  if (normalized.some(({ address, family }) => (
    ![4, 6].includes(family)
    || net.isIP(address) !== family
    || isPrivateIp(address)
  ))) {
    const error = new Error(`资源主机 ${hostname} 解析到私有、回环、保留或无效地址。`);
    error.code = "LANHU_UNSAFE_DNS";
    throw error;
  }
  return normalized;
}

async function resolvePublicAddresses(hostname, { signal, deadline }) {
  const resolver = networkHooks.createResolver();
  try {
    const candidates = [
      Promise.resolve()
        .then(() => resolver.resolve4(hostname))
        .then((addresses) => normalizePublicAddresses(hostname, addresses, 4)),
      Promise.resolve()
        .then(() => resolver.resolve6(hostname))
        .then((addresses) => normalizePublicAddresses(hostname, addresses, 6)),
    ];
    try {
      return await awaitUntil(Promise.any(candidates), {
        signal,
        deadline,
        timeoutMessage: `DNS 解析 ${hostname} 超时。`,
      });
    } catch (error) {
      if (signal.aborted || error?.code === "LANHU_HTTP_TIMEOUT") throw error;
      const reasons = error instanceof AggregateError ? error.errors : [error];
      const unsafe = reasons.find((reason) => reason?.code === "LANHU_UNSAFE_DNS");
      if (unsafe) throw unsafe;
      const detail = reasons.find((reason) => reason?.message)?.message || error.message;
      throw new Error(`无法解析资源主机 ${hostname}: ${detail}`);
    }
  } finally {
    resolver.cancel();
  }
}

async function assertPublicHttpsUrl(rawUrl, deadlineOptions) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("资源 URL 无效。");
  }
  if (parsed.protocol !== "https:") throw new Error("资源 URL 必须使用 HTTPS。");
  if (parsed.port && parsed.port !== "443") throw new Error("资源 URL 只允许 HTTPS 默认端口 443。");
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
    return {
      parsed,
      addresses: [{ address: hostname, family: net.isIP(hostname) }],
    };
  }
  return { parsed, addresses: await resolvePublicAddresses(hostname, deadlineOptions) };
}

function requestPinnedAddress(parsed, options, target) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: target.address,
      family: target.family,
      port: 443,
      servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...options.headers,
        Host: parsed.host,
      },
      rejectUnauthorized: true,
      signal: options.signal,
    });
    request.once("response", (incoming) => {
      const headers = {
        get(name) {
          const value = incoming.headers[String(name).toLowerCase()];
          if (Array.isArray(value)) return value.join(", ");
          return value == null ? null : String(value);
        },
      };
      resolve({
        status: Number(incoming.statusCode || 0),
        statusText: String(incoming.statusMessage || ""),
        ok: Number(incoming.statusCode) >= 200 && Number(incoming.statusCode) < 300,
        headers,
        body: incoming,
        url: parsed.href,
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function pinnedPublicFetch(parsed, options, addresses) {
  let lastError = null;
  for (const target of addresses) {
    try {
      return await requestPinnedAddress(parsed, options, target);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error(`无法连接资源主机 ${parsed.hostname}。`);
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const failure = timeoutError(timeoutMs);
  const timeout = setTimeout(() => controller.abort(failure), timeoutMs);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    controller.abort();
  };
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const publicTarget = options.authenticated
        ? null
        : await assertPublicHttpsUrl(current, { signal: controller.signal, deadline });
      const parsed = options.authenticated
        ? assertAuthenticatedEndpoint(current)
        : publicTarget.parsed;
      const fetcher = options.authenticated ? networkHooks.fetch : networkHooks.publicFetch;
      const response = await awaitUntil(fetcher(parsed, {
          method: "GET",
          headers: options.headers(parsed),
          redirect: "manual",
          signal: controller.signal,
        }, publicTarget?.addresses), {
          signal: controller.signal,
          deadline,
          timeoutMessage: failure.message,
        });
      if (!isRedirect(response.status)) {
        return { response, cleanup, signal: controller.signal };
      }
      if (typeof response.body?.cancel === "function") {
        await awaitUntil(response.body.cancel(), {
          signal: controller.signal,
          deadline,
          timeoutMessage: failure.message,
        }).catch((error) => {
          if (controller.signal.aborted) throw error;
        });
      } else if (typeof response.body?.destroy === "function") {
        response.body.destroy();
      }
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
  } catch (error) {
    cleanup();
    if (controller.signal.reason?.code === "LANHU_HTTP_TIMEOUT") throw controller.signal.reason;
    if (Date.now() >= deadline) throw failure;
    throw error;
  }
}

async function readLimitedBody(response, maxBytes, signal) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`响应体 ${declared} 字节超过限制 ${maxBytes} 字节。`);
  }
  if (!response.body) return Buffer.alloc(0);
  const iterator = response.body[Symbol.asyncIterator]?.();
  if (!iterator) throw new Error("响应体不可读取。");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await awaitUntil(iterator.next(), {
        signal,
        deadline: Number.POSITIVE_INFINITY,
        timeoutMessage: "读取响应体超时。",
      });
      if (next.done) break;
      const buffer = Buffer.from(next.value);
      total += buffer.length;
      if (total > maxBytes) throw new Error(`响应体超过限制 ${maxBytes} 字节。`);
      chunks.push(buffer);
    }
  } catch (error) {
    if (typeof response.body.destroy === "function") response.body.destroy();
    else Promise.resolve(iterator.return?.()).catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function assertOk(response, label) {
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label}认证失败 (HTTP ${response.status})。LANHU_COOKIE 可能已过期。`);
  }
  if (!response.ok) throw new Error(`${label}HTTP ${response.status} ${response.statusText}`);
}

function validRasterDimensions(width, height) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= 100_000
    && height <= 100_000
    && width * height <= MAX_DECODED_PIXELS;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function looksLikePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || next > buffer.length) return false;
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      if (!validRasterDimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12))) return false;
      const bitDepth = buffer[offset + 16];
      const colorType = buffer[offset + 17];
      const allowedDepths = new Map([
        [0, new Set([1, 2, 4, 8, 16])],
        [2, new Set([8, 16])],
        [3, new Set([1, 2, 4, 8])],
        [4, new Set([8, 16])],
        [6, new Set([8, 16])],
      ]);
      if (!allowedDepths.get(colorType)?.has(bitDepth)) return false;
      if (buffer[offset + 18] !== 0 || buffer[offset + 19] !== 0 || ![0, 1].includes(buffer[offset + 20])) return false;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT") {
      if (length === 0) return false;
      sawData = true;
    }
    if (type === "IEND") return length === 0 && sawData && next === buffer.length;
    offset = next;
  }
  return false;
}

function looksLikeJpeg(buffer) {
  if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let entropyBytes = 0;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 2 <= buffer.length) {
    if (buffer[offset] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return false;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && entropyBytes > 0 && offset === buffer.length;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0x01) continue;
    if (offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if (frameMarkers.has(marker)) {
      if (sawFrame || length < 11) return false;
      const components = buffer[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + (3 * components)) return false;
      if (![8, 12].includes(buffer[offset + 2])) return false;
      if (!validRasterDimensions(buffer.readUInt16BE(offset + 3), buffer.readUInt16BE(offset + 5))) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      const components = buffer[offset + 2];
      if (!sawFrame || components < 1 || components > 4 || length !== 6 + (2 * components)) return false;
      sawScan = true;
      offset += length;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        if (offset + 1 >= buffer.length) return false;
        const next = buffer[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          entropyBytes += 1;
          offset += 2;
          continue;
        }
        if (next === 0xff) {
          offset += 1;
          continue;
        }
        break;
      }
      continue;
    }
    offset += length;
  }
  return false;
}

function looksLikeGif(buffer) {
  if (buffer.length < 14 || !["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return false;
  const logicalWidth = buffer.readUInt16LE(6);
  const logicalHeight = buffer.readUInt16LE(8);
  if (!validRasterDimensions(logicalWidth, logicalHeight)) return false;
  let offset = 13;
  const packed = buffer[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  if (offset > buffer.length) return false;
  let sawImage = false;
  const consumeSubBlocks = () => {
    let payloadBytes = 0;
    while (offset < buffer.length) {
      const size = buffer[offset];
      offset += 1;
      if (size === 0) return payloadBytes;
      if (offset + size > buffer.length) return -1;
      payloadBytes += size;
      offset += size;
    }
    return -1;
  };
  while (offset < buffer.length) {
    const introducer = buffer[offset];
    offset += 1;
    if (introducer === 0x3b) return sawImage && offset === buffer.length;
    if (introducer === 0x21) {
      if (offset >= buffer.length) return false;
      offset += 1;
      if (consumeSubBlocks() < 0) return false;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > buffer.length) return false;
    const left = buffer.readUInt16LE(offset);
    const top = buffer.readUInt16LE(offset + 2);
    const width = buffer.readUInt16LE(offset + 4);
    const height = buffer.readUInt16LE(offset + 6);
    if (!validRasterDimensions(width, height) || left + width > logicalWidth || top + height > logicalHeight) return false;
    const imagePacked = buffer[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
    if (offset >= buffer.length || buffer[offset] < 2 || buffer[offset] > 8) return false;
    offset += 1;
    if (consumeSubBlocks() <= 0) return false;
    sawImage = true;
  }
  return false;
}

function looksLikeWebp(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString("ascii") !== "RIFF") return false;
  if (buffer.subarray(8, 12).toString("ascii") !== "WEBP") return false;
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) return false;
  let offset = 12;
  let firstChunk = true;
  let canvasValid = false;
  let sawFrameData = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[ -~]{4}$/.test(type)) return false;
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + (length % 2);
    if (dataEnd > buffer.length || next > buffer.length) return false;
    const payload = buffer.subarray(dataStart, dataEnd);
    if (firstChunk && !["VP8 ", "VP8L", "VP8X"].includes(type)) return false;
    if (type === "VP8 ") {
      if (payload.length <= 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return false;
      if (!validRasterDimensions(payload.readUInt16LE(6) & 0x3fff, payload.readUInt16LE(8) & 0x3fff)) return false;
      canvasValid = true;
      sawFrameData = true;
    } else if (type === "VP8L") {
      if (payload.length <= 5 || payload[0] !== 0x2f) return false;
      const width = 1 + payload[1] + ((payload[2] & 0x3f) << 8);
      const height = 1 + (payload[2] >> 6) + (payload[3] << 2) + ((payload[4] & 0x0f) << 10);
      if (!validRasterDimensions(width, height)) return false;
      canvasValid = true;
      sawFrameData = true;
    } else if (type === "VP8X") {
      if (!firstChunk || payload.length !== 10) return false;
      const width = 1 + payload.readUIntLE(4, 3);
      const height = 1 + payload.readUIntLE(7, 3);
      if (!validRasterDimensions(width, height)) return false;
      canvasValid = true;
    } else if (type === "ANMF") {
      if (!canvasValid || payload.length <= 16) return false;
      sawFrameData = true;
    }
    firstChunk = false;
    offset = next;
  }
  return offset === buffer.length && canvasValid && sawFrameData;
}

function looksLikeImage(buffer, contentType) {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (type === "image/png") return looksLikePng(buffer);
  if (["image/jpeg", "image/jpg"].includes(type)) return looksLikeJpeg(buffer);
  if (type === "image/gif") return looksLikeGif(buffer);
  if (type === "image/webp") return looksLikeWebp(buffer);
  if (type === "application/octet-stream") {
    return looksLikePng(buffer) || looksLikeJpeg(buffer) || looksLikeGif(buffer) || looksLikeWebp(buffer);
  }
  return false;
}

async function fullyDecodesRaster(buffer, contentType) {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  const expectedFormat = new Map([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/jpg", "jpeg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ]).get(type) || null;
  if (!expectedFormat && type !== "application/octet-stream") return null;

  const inputOptions = {
    animated: true,
    failOn: "warning",
    limitInputPixels: MAX_DECODED_PIXELS,
    sequentialRead: true,
  };
  try {
    const metadata = await sharp(buffer, inputOptions).metadata();
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    const pages = Number(metadata.pages || 1);
    const pageHeight = Number(metadata.pageHeight || height);
    if ((expectedFormat && metadata.format !== expectedFormat)
      || !validRasterDimensions(width, height)
      || !Number.isInteger(pages)
      || pages < 1
      || pages > MAX_IMAGE_FRAMES
      || !validRasterDimensions(width, pageHeight)
      || width * pageHeight * pages > MAX_DECODED_PIXELS) {
      return null;
    }

    const decoded = await sharp(buffer, inputOptions)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const valid = decoded.data.length > 0
      && decoded.data.length <= MAX_DECODED_IMAGE_BYTES
      && validRasterDimensions(Number(decoded.info.width), Number(decoded.info.height));
    return valid ? metadata.format : null;
  } catch {
    return null;
  }
}

export async function fetchLanhuJson(url, { dds = false } = {}) {
  const parsed = assertAuthenticatedEndpoint(url);
  const authenticatedHeaders = {
    ...COMMON_HEADERS,
    Referer: dds ? "https://dds.lanhuapp.com/" : "https://lanhuapp.com/web/",
    ...(dds ? { Authorization: "Basic dW5kZWZpbmVkOg==" } : {
      "request-from": "web",
      "real-path": "/item/project/product",
    }),
  };

  if (authenticationMode() === "browser") {
    return fetchLanhuJsonWithBrowser(parsed.href, {
      headers: authenticatedHeaders,
      label: dds ? "DDS " : "蓝湖 API ",
      maxBytes: DEFAULT_JSON_LIMIT,
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      validateUrl: assertAuthenticatedEndpoint,
    });
  }

  const { response, cleanup, signal } = await fetchFollowingRedirects(url, {
    authenticated: true,
    headers: () => ({
      ...authenticatedHeaders,
      Cookie: getCookie(),
    }),
  });
  try {
    assertOk(response, dds ? "DDS " : "");
    const buffer = await readLimitedBody(response, DEFAULT_JSON_LIMIT, signal);
    try {
      return JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("蓝湖 API 返回的不是有效 JSON。");
    }
  } finally {
    cleanup();
  }
}

export async function closeAuthenticatedSession() {
  await closeBrowserSession();
}

export async function fetchResourceJson(url) {
  const { response, cleanup, signal } = await fetchFollowingRedirects(url, {
    authenticated: false,
    headers: () => ({ ...COMMON_HEADERS }),
  });
  try {
    assertOk(response, "资源 ");
    const buffer = await readLimitedBody(response, DEFAULT_JSON_LIMIT, signal);
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
  const { response, cleanup, signal } = await fetchFollowingRedirects(url, {
    authenticated: false,
    headers: () => ({
      "User-Agent": COMMON_HEADERS["User-Agent"],
      Accept: "image/png,image/jpeg,image/webp,image/gif",
      ...(safeReferer ? { Referer: safeReferer } : {}),
    }),
  });
  try {
    assertOk(response, "资源 ");
    const buffer = await readLimitedBody(response, DEFAULT_ASSET_LIMIT, signal);
    const contentType = response.headers.get("content-type") || "";
    const decodedFormat = looksLikeImage(buffer, contentType)
      ? await fullyDecodesRaster(buffer, contentType)
      : null;
    if (!decodedFormat) {
      throw new Error(`资源不是受支持的图片类型 (Content-Type: ${contentType || "missing"})。`);
    }
    const canonicalContentType = decodedFormat === "jpeg" ? "image/jpeg" : `image/${decodedFormat}`;
    return { buffer, contentType: canonicalContentType, finalUrl: response.url || String(url) };
  } finally {
    cleanup();
  }
}

export function __setNetworkHooksForTests(hooks) {
  if (process.env.NODE_ENV !== "test") throw new Error("测试网络钩子仅允许在 NODE_ENV=test 时设置。");
  let createResolver = networkHooks.createResolver;
  if (hooks.createResolver) {
    createResolver = hooks.createResolver;
  } else if (hooks.lookup || hooks.resolve4 || hooks.resolve6) {
    createResolver = () => {
      let lookupPromise;
      const lookupFamily = async (hostname, family) => {
        lookupPromise ||= Promise.resolve().then(() => hooks.lookup(hostname, {
          all: true,
          verbatim: true,
        }));
        const entries = await lookupPromise;
        return entries
          .filter((entry) => Number(entry.family) === family)
          .map((entry) => String(entry.address));
      };
      return {
        resolve4: hooks.resolve4 || ((hostname) => lookupFamily(hostname, 4)),
        resolve6: hooks.resolve6 || ((hostname) => lookupFamily(hostname, 6)),
        cancel: hooks.cancelResolver || (() => {}),
      };
    };
  }
  networkHooks = {
    fetch: hooks.fetch || networkHooks.fetch,
    publicFetch: hooks.publicFetch || hooks.fetch || networkHooks.publicFetch,
    createResolver,
  };
}

export function __resetNetworkHooksForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("测试网络钩子仅允许在 NODE_ENV=test 时重置。");
  networkHooks = {
    fetch: (...args) => globalThis.fetch(...args),
    publicFetch: pinnedPublicFetch,
    createResolver: () => new DnsResolver(),
  };
}

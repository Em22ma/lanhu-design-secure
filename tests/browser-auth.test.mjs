#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const browserAuth = await import("../skills/lanhu-design-secure/scripts/browser-session.mjs");

function jsonResponse(data, options = {}) {
  const body = Buffer.from(JSON.stringify(data));
  const headers = {
    "content-type": "application/json",
    "content-length": String(body.length),
    ...(options.headers || {}),
  };
  return {
    status: () => options.status ?? 200,
    statusText: () => options.statusText || "OK",
    headers: () => headers,
    body: async () => body,
    dispose: async () => {},
  };
}

function redirectResponse(location) {
  return {
    status: () => 302,
    statusText: () => "Found",
    headers: () => ({ location, "content-length": "0" }),
    body: async () => Buffer.alloc(0),
    dispose: async () => {},
  };
}

async function mockRequestInPage(context, url, options) {
  const response = await context.request.get(url, {
    headers: options.headers,
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: options.timeoutMs,
  });
  const body = await response.body();
  const headers = Object.fromEntries(
    Object.entries(response.headers()).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  let data = null;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    // Tests use bounded non-JSON bodies to model authentication failures.
  }
  return {
    status: response.status(),
    statusText: response.statusText(),
    headers,
    body,
    data,
  };
}

function exactLanhuEndpoint(rawUrl) {
  const parsed = new URL(rawUrl);
  assert.equal(parsed.origin, "https://lanhuapp.com");
  assert.equal(parsed.pathname, "/api/project/images");
  return parsed;
}

function requestOptions(overrides = {}) {
  return {
    headers: { Accept: "application/json", Referer: "https://lanhuapp.com/web/" },
    label: "蓝湖 API ",
    loginTimeoutMs: 30_000,
    maxBytes: 1024 * 1024,
    maxRedirects: 5,
    timeoutMs: 5_000,
    validateUrl: exactLanhuEndpoint,
    ...overrides,
  };
}

function rawBrokerRequest(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      let newline = received.indexOf("\n");
      while (newline !== -1) {
        const parsed = JSON.parse(received.slice(0, newline));
        received = received.slice(newline + 1);
        if (!parsed?.event) {
          socket.destroy();
          resolve(parsed);
          return;
        }
        newline = received.indexOf("\n");
      }
    });
    socket.once("error", reject);
  });
}

test.afterEach(async () => {
  await browserAuth.__stopBrowserBrokerForTests();
  browserAuth.__resetBrowserHooksForTests();
  browserAuth.__resetBrokerHooksForTests();
  delete process.env.LANHU_BROWSER_PROFILE_DIR;
  delete process.env.LANHU_NONINTERACTIVE;
});

test("first authenticated request stays in the browser context that completed login", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-auth-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;

  const launches = [];
  const ignoredDefaults = [];
  const requests = [];
  const navigations = [];

  const chromium = {
    launchPersistentContext: async (_profile, launchOptions) => {
      launches.push(launchOptions.headless);
      ignoredDefaults.push(launchOptions.ignoreDefaultArgs);
      assert.equal(launchOptions.chromiumSandbox, true);
      let loggedIn = false;
      const page = {
        goto: async (url) => {
          navigations.push(url);
          loggedIn = true;
        },
        bringToFront: async () => {},
        isClosed: () => false,
      };
      return {
        request: {
          get: async (url, options) => {
            requests.push({ url, options });
            return loggedIn
              ? jsonResponse({ code: "00000", data: { name: "Demo", images: [] } })
              : jsonResponse("You don't have the permission to access this project!", { status: 418 });
          },
        },
        pages: () => launchOptions.headless ? [] : [page],
        newPage: async () => page,
        close: async () => {},
      };
    },
  };

  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    requestInPage: mockRequestInPage,
    loadPlaywright: async () => ({ chromium }),
    sleep: async () => {},
    stderr: () => {},
  });

  try {
    const result = await browserAuth.__fetchLanhuJsonInBrowserForTests(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    assert.equal(result.code, "00000");
    assert.deepEqual(launches, [false]);
    for (const ignored of ignoredDefaults) {
      assert.deepEqual(ignored, ["--password-store=basic", "--use-mock-keychain", "--no-sandbox"]);
    }
    assert.deepEqual(navigations, ["https://lanhuapp.com/web/"]);
    assert.ok(requests.length >= 2);
    for (const request of requests) {
      assert.equal(request.options.maxRedirects, 0);
      assert.equal(
        Object.keys(request.options.headers).some((name) => name.toLowerCase() === "cookie"),
        false,
      );
    }
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("local broker keeps one authenticated browser context across command cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-broker-"));
  const profile = path.join(root, "profile");
  const socket = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;

  const launches = [];
  let requests = 0;
  const chromium = {
    launchPersistentContext: async (_profile, launchOptions) => {
      launches.push(launchOptions.headless);
      let loggedIn = false;
      const page = {
        goto: async () => { loggedIn = true; },
        bringToFront: async () => {},
        isClosed: () => false,
      };
      return {
        request: {
          get: async () => {
            requests += 1;
            return loggedIn
              ? jsonResponse({ code: "00000", data: { name: "Demo", images: [] } })
              : jsonResponse("You don't have the permission to access this project!", { status: 418 });
          },
        },
        pages: () => [page],
        newPage: async () => page,
        close: async () => {},
      };
    },
  };

  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    requestInPage: mockRequestInPage,
    loadPlaywright: async () => ({ chromium }),
    sleep: async () => {},
    stderr: () => {},
  });
  browserAuth.__setBrokerHooksForTests({ socketPath: socket });

  try {
    await browserAuth.__startBrowserBrokerForTests();
    if (process.platform !== "win32") {
      assert.equal((await stat(socket)).mode & 0o777, 0o600);
    }
    const rejectedEndpoint = await rawBrokerRequest(socket, {
      protocol: 2,
      action: "request",
      url: "https://attacker.example/api/project/images?project_id=p1",
      options: requestOptions(),
    });
    assert.equal(rejectedEndpoint.ok, false);
    assert.match(rejectedEndpoint.error, /非白名单端点/);
    const rejectedCookie = await rawBrokerRequest(socket, {
      protocol: 2,
      action: "request",
      url: "https://lanhuapp.com/api/project/images?project_id=p1",
      options: requestOptions({ headers: { Cookie: "secret" } }),
    });
    assert.equal(rejectedCookie.ok, false);
    assert.match(rejectedCookie.error, /禁止客户端提供 Cookie/);
    const rejectedOverride = await rawBrokerRequest(socket, {
      protocol: 2,
      action: "request",
      url: "https://lanhuapp.com/api/project/images?project_id=p1",
      options: requestOptions({ headers: { "X-HTTP-Method-Override": "POST" } }),
    });
    assert.equal(rejectedOverride.ok, false);
    assert.match(rejectedOverride.error, /请求头不在白名单/);
    const rawSuccess = await rawBrokerRequest(socket, {
      protocol: 2,
      action: "request",
      url: "https://lanhuapp.com/api/project/images?project_id=p1",
      options: requestOptions(),
    });
    assert.equal(rawSuccess.ok, true);
    assert.equal(Object.hasOwn(rawSuccess, "data"), false);
    assert.equal(typeof rawSuccess.bodyBase64, "string");
    assert.equal(
      JSON.parse(Buffer.from(rawSuccess.bodyBase64, "base64").toString("utf8")).code,
      "00000",
    );
    const first = await browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    await browserAuth.closeBrowserSession();
    const second = await browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    assert.equal(first.code, "00000");
    assert.equal(second.code, "00000");
    assert.deepEqual(launches, [false]);
    assert.ok(requests >= 3);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker client rejects non-allowlisted endpoints and explicit credentials", async () => {
  await assert.rejects(
    browserAuth.fetchLanhuJsonWithBrowser(
      "https://attacker.example/api/project/images?project_id=p1",
      requestOptions(),
    ),
    /非白名单端点/,
  );
  await assert.rejects(
    browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions({ headers: { Cookie: "secret" } }),
    ),
    /禁止客户端提供 Cookie/,
  );
});

test("detached broker environment excludes unrelated caller secrets", () => {
  process.env.LANHU_TEST_SENTINEL_SECRET = "must-not-survive";
  process.env.LANHU_BROKER_START_TOKEN = "caller-controlled-token";
  process.env.LANHU_BROWSER_CHANNEL = "chrome";
  try {
    const environment = browserAuth.__browserBrokerEnvironmentForTests();
    assert.equal(environment.LANHU_TEST_SENTINEL_SECRET, undefined);
    assert.equal(environment.LANHU_COOKIE, undefined);
    assert.equal(environment.LANHU_BROKER_START_TOKEN, undefined);
    assert.equal(environment.LANHU_BROWSER_CHANNEL, "chrome");
    assert.equal(environment.LANHU_AUTH_MODE, "browser");
    assert.equal(environment.HOME, process.env.HOME);
    assert.equal(environment.PATH, process.env.PATH);
  } finally {
    delete process.env.LANHU_TEST_SENTINEL_SECRET;
    delete process.env.LANHU_BROKER_START_TOKEN;
    delete process.env.LANHU_BROWSER_CHANNEL;
  }
});

test("authenticated browser streams and cancels an oversized response", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-bounded-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(path.join(profile, ".lanhu-session-initialized-v1"), { recursive: true, mode: 0o700 });
  let requestContextUsed = false;
  let chunksRead = 0;
  const page = {
    goto: async () => {},
    url: () => "https://lanhuapp.com/",
    close: async () => {},
    evaluate: async (pageFunction, input) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) {
          chunksRead += 1;
          controller.enqueue(new Uint8Array(256 * 1024));
          if (chunksRead >= 10) controller.close();
        },
      }), { headers: { "content-type": "application/json" } });
      try {
        return await pageFunction(input);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  };
  const chromium = {
    launchPersistentContext: async () => ({
      request: {
        get: async () => {
          requestContextUsed = true;
          throw new Error("APIRequestContext must not be used");
        },
      },
      pages: () => [],
      newPage: async () => page,
      close: async () => {},
    }),
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({ chromium }),
  });

  try {
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions(),
      ),
      /超过限制/,
    );
    assert.equal(requestContextUsed, false);
    assert.ok(chunksRead < 10, "stream reader should cancel before the full response is produced");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive login uses one absolute deadline across navigation and polling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-login-deadline-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  let now = 0;
  const originalNow = Date.now;
  const requestTimeouts = [];
  const page = {
    goto: async (_url, options) => {
      assert.equal(options.timeout, 30_000);
      now += 25_000;
    },
    bringToFront: async () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const chromium = {
    launchPersistentContext: async () => ({
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
    }),
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({ chromium }),
    requestInPage: async (_context, _url, options) => {
      requestTimeouts.push(options.timeoutMs);
      now += options.timeoutMs;
      return {
        status: 418,
        statusText: "Authentication Required",
        headers: { "content-type": "application/json" },
        body: Buffer.from('"login required"'),
        data: "login required",
      };
    },
    sleep: async (milliseconds) => { now += milliseconds; },
    stderr: () => {},
  });

  try {
    Date.now = () => now;
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions({ loginTimeoutMs: 30_000, timeoutMs: 20_000 }),
      ),
      /等待蓝湖登录超时/,
    );
    assert.deepEqual(requestTimeouts, [5_000]);
    assert.equal(now, 30_000);
  } finally {
    Date.now = originalNow;
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive login retries coded browser-page failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-login-retry-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  let attempts = 0;
  const page = {
    goto: async () => {},
    bringToFront: async () => {},
    isClosed: () => false,
    close: async () => {},
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => ({
          pages: () => [page],
          newPage: async () => page,
          close: async () => {},
        }),
      },
    }),
    requestInPage: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("蓝湖认证流式请求失败。");
        error.code = "page_failure";
        throw error;
      }
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"code":"00000","data":{"images":[]}}'),
        data: { code: "00000", data: { images: [] } },
      };
    },
    sleep: async () => {},
    stderr: () => {},
  });

  try {
    const result = await browserAuth.__fetchLanhuJsonInBrowserForTests(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    assert.equal(result.code, "00000");
    assert.equal(attempts, 3, "login polling should recover, then perform the authenticated request");
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting the first authenticated page navigation closes it promptly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-navigation-abort-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(path.join(profile, ".lanhu-session-initialized-v1"), { recursive: true, mode: 0o700 });
  const controller = new AbortController();
  let markNavigationStarted;
  let rejectNavigation;
  let closed = false;
  const navigationStarted = new Promise((resolve) => { markNavigationStarted = resolve; });
  const page = {
    goto: async () => {
      markNavigationStarted();
      return new Promise((_, reject) => { rejectNavigation = reject; });
    },
    url: () => "https://lanhuapp.com/",
    isClosed: () => closed,
    close: async () => {
      closed = true;
      rejectNavigation?.(new Error("page closed"));
    },
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => page,
          close: async () => page.close(),
        }),
      },
    }),
  });

  try {
    const pending = browserAuth.__fetchLanhuJsonInBrowserForTests(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions({ signal: controller.signal }),
    );
    pending.catch(() => {});
    await navigationStarted;
    controller.abort();
    await assert.rejects(pending, /请求已取消/);
    assert.equal(closed, true);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed cached request page is evicted and retried once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-page-retry-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(path.join(profile, ".lanhu-session-initialized-v1"), { recursive: true, mode: 0o700 });
  let created = 0;
  const body = Buffer.from('{"code":"00000","data":{"images":[]}}');
  const makePage = () => {
    created += 1;
    const ordinal = created;
    let closed = false;
    return {
      goto: async () => {},
      url: () => "https://lanhuapp.com/",
      isClosed: () => closed,
      close: async () => { closed = true; },
      evaluate: async () => {
        if (ordinal === 1) throw new Error("renderer crashed");
        return {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          bodyBase64: body.toString("base64"),
        };
      },
    };
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => makePage(),
          close: async () => {},
        }),
      },
    }),
  });

  try {
    const result = await browserAuth.__fetchLanhuJsonInBrowserForTests(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    assert.equal(result.code, "00000");
    assert.equal(created, 2);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a browser page retry cannot extend the original request deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-page-deadline-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(path.join(profile, ".lanhu-session-initialized-v1"), { recursive: true, mode: 0o700 });
  const originalNow = Date.now;
  let now = 0;
  let created = 0;
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => {
            created += 1;
            let closed = false;
            return {
              goto: async () => {},
              url: () => "https://lanhuapp.com/",
              isClosed: () => closed,
              close: async () => { closed = true; },
              evaluate: async () => {
                now = 5_000;
                throw new Error("renderer crashed at deadline");
              },
            };
          },
          close: async () => {},
        }),
      },
    }),
  });

  try {
    Date.now = () => now;
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions({ timeoutMs: 5_000 }),
      ),
      /请求超时/,
    );
    assert.equal(created, 1, "deadline exhaustion must prevent a second page attempt");
  } finally {
    Date.now = originalNow;
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive login timeout also bounds a pending newPage call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-new-page-timeout-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  let resolvePage;
  let closed = false;
  const delayedPage = new Promise((resolve) => { resolvePage = resolve; });
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => ({
          pages: () => [],
          newPage: async () => delayedPage,
          close: async () => {},
        }),
      },
    }),
    stderr: () => {},
  });

  try {
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions({ loginTimeoutMs: 20 }),
      ),
      /等待蓝湖登录超时/,
    );
    resolvePage({ close: async () => { closed = true; } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, true, "a page created after timeout must be closed");
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop waits for a detached broker that is still in its startup window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-start-stop-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  browserAuth.__setBrowserHooksForTests({ sessionRoot: root });
  browserAuth.__setBrokerHooksForTests({ socketPath });
  const markerPath = await browserAuth.__browserBrokerStartupPathForTests();
  let server;
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });

  browserAuth.__setBrokerHooksForTests({
    spawnBroker: () => {
      markSpawned();
      setTimeout(() => {
        server = net.createServer((socket) => {
          let received = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            received += chunk;
            const newline = received.indexOf("\n");
            if (newline === -1) return;
            const message = JSON.parse(received.slice(0, newline));
            if (message.action === "ping") {
              socket.end(`${JSON.stringify({ ok: true, protocol: 2, status: "running" })}\n`);
            } else if (message.action === "request") {
              const body = Buffer.from('{"code":"00000","data":{"images":[]}}');
              socket.end(`${JSON.stringify({
                ok: true,
                protocol: 2,
                bodyBase64: body.toString("base64"),
              })}\n`);
            } else if (message.action === "shutdown") {
              socket.end(`${JSON.stringify({ ok: true, protocol: 2, status: "stopping" })}\n`);
              setTimeout(() => server.close(() => {}), 100);
            }
          });
        });
        server.listen(socketPath, async () => {
          await unlink(markerPath).catch(() => {});
        });
      }, 20);
      return 4242;
    },
  });

  try {
    const fetch = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    fetch.catch(() => {});
    await spawned;
    assert.equal(await browserAuth.browserBrokerStatus(), "starting");
    const stopped = await browserAuth.stopBrowserBroker();
    assert.deepEqual(stopped, { status: "stopped" });
    assert.equal(await browserAuth.browserBrokerStatus(), "stopped");
    assert.equal((await fetch).code, "00000");
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await unlink(markerPath).catch(() => {});
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale startup marker with a live owner is never reported as stopped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-stale-start-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  let now = 31_001;
  const originalNow = Date.now;
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    sleep: async () => { now += 5_000; },
  });
  browserAuth.__setBrokerHooksForTests({ socketPath });
  const markerPath = await browserAuth.__browserBrokerStartupPathForTests();
  await writeFile(markerPath, `${JSON.stringify({
    pid: String(process.pid).padStart(20, "0"),
    startedAt: 1,
    token: "a".repeat(64),
  })}\n`, { mode: 0o600 });

  try {
    Date.now = () => now;
    assert.equal(await browserAuth.browserBrokerStatus(), "starting");
    const stopped = await browserAuth.stopBrowserBroker();
    assert.equal(stopped.status, "stop_failed");
    assert.match(stopped.error, /仍在启动/);
    assert.ok((await readFile(markerPath, "utf8")).includes(String(process.pid)));
  } finally {
    Date.now = originalNow;
    await unlink(markerPath).catch(() => {});
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker management stays responsive while login is pending and stops idle clients", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-management-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  let markLoginStarted;
  let launches = 0;
  const loginStarted = new Promise((resolve) => { markLoginStarted = resolve; });
  const chromium = {
    launchPersistentContext: async () => {
      launches += 1;
      const page = {
        goto: async () => { markLoginStarted(); },
        bringToFront: async () => {},
        isClosed: () => false,
      };
      return {
        request: {
          get: async () => jsonResponse("login required", { status: 418 }),
        },
        pages: () => [page],
        newPage: async () => page,
        close: async () => {},
      };
    },
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    requestInPage: mockRequestInPage,
    loadPlaywright: async () => ({ chromium }),
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 10)),
    stderr: () => {},
  });
  browserAuth.__setBrokerHooksForTests({ socketPath });

  let idleSocket;
  try {
    await browserAuth.__startBrowserBrokerForTests();
    const pending = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    pending.catch(() => {});
    await loginStarted;
    const queued = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/image?project_id=p1&image_id=i1",
      requestOptions(),
    );
    queued.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await browserAuth.browserBrokerStatus(), "busy");

    idleSocket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      idleSocket.once("connect", resolve);
      idleSocket.once("error", reject);
    });
    assert.deepEqual(await browserAuth.stopBrowserBroker(), { status: "stopped" });
    await assert.rejects(pending);
    await assert.rejects(queued);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await browserAuth.browserBrokerStatus(), "stopped");
    assert.equal(idleSocket.destroyed, true);
    assert.equal(launches, 1, "queued requests must not relaunch a browser after shutdown");
  } finally {
    idleSocket?.destroy();
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker shutdown aborts queued work before closing an in-flight browser request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-shutdown-queue-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(path.join(profile, ".lanhu-session-initialized-v1"), { recursive: true, mode: 0o700 });

  let launches = 0;
  let rejectRequest;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const chromium = {
    launchPersistentContext: async () => {
      launches += 1;
      return {
        request: {
          get: async () => {
            markRequestStarted();
            return new Promise((_, reject) => { rejectRequest = reject; });
          },
        },
        pages: () => [],
        close: async () => rejectRequest?.(new Error("browser closed")),
      };
    },
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    requestInPage: mockRequestInPage,
    loadPlaywright: async () => ({ chromium }),
    stderr: () => {},
  });
  browserAuth.__setBrokerHooksForTests({ socketPath });

  let queued;
  try {
    await browserAuth.__startBrowserBrokerForTests();
    const active = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    active.catch(() => {});
    await requestStarted;
    queued = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/image?project_id=p1&image_id=i1",
      requestOptions(),
    );
    queued.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(await browserAuth.stopBrowserBroker(), { status: "stopped" });
    await assert.rejects(active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(launches, 1, "shutdown must not let queued work relaunch the browser");
    await assert.rejects(queued);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await queued?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("broker shutdown closes a browser that finishes launching after stop begins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-shutdown-launch-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;

  let markLaunchStarted;
  let resolveLaunch;
  let closed = false;
  let navigations = 0;
  const launchStarted = new Promise((resolve) => { markLaunchStarted = resolve; });
  const delayedLaunch = new Promise((resolve) => { resolveLaunch = resolve; });
  const page = {
    goto: async () => { navigations += 1; },
    bringToFront: async () => {},
    isClosed: () => false,
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => { closed = true; },
  };
  const chromium = {
    launchPersistentContext: async () => {
      markLaunchStarted();
      return delayedLaunch;
    },
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({ chromium }),
    stderr: () => {},
  });
  browserAuth.__setBrokerHooksForTests({ socketPath });

  try {
    await browserAuth.__startBrowserBrokerForTests();
    const pending = browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    pending.catch(() => {});
    await launchStarted;
    const stopping = browserAuth.stopBrowserBroker();
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveLaunch(context);

    assert.deepEqual(await stopping, { status: "stopped" });
    await assert.rejects(pending);
    assert.equal(closed, true);
    assert.equal(navigations, 0, "a stale launch must not navigate to the login page");
    assert.equal(await browserAuth.browserBrokerStatus(), "stopped");
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("management reports an incompatible live broker instead of stopped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-incompatible-"));
  const profile = path.join(root, "profile");
  const socketPath = path.join(root, "broker.sock");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  browserAuth.__setBrowserHooksForTests({ sessionRoot: root });
  browserAuth.__setBrokerHooksForTests({ socketPath });

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.once("data", () => {
      socket.end(`${JSON.stringify({ ok: true, protocol: 999, status: "running" })}\n`);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    assert.equal(await browserAuth.browserBrokerStatus(), "incompatible");
    const stopped = await browserAuth.stopBrowserBroker();
    assert.equal(stopped.status, "stop_failed");
    assert.match(stopped.error, /未确认停止/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("browser authentication rejects cross-origin redirects before following them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-redirect-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;
  await mkdir(
    path.join(profile, ".lanhu-session-initialized-v1"),
    { recursive: true, mode: 0o700 },
  );
  let requests = 0;
  const chromium = {
    launchPersistentContext: async () => ({
      request: {
        get: async () => {
          requests += 1;
          return redirectResponse("https://attacker.example/steal");
        },
      },
      close: async () => {},
    }),
  };
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    requestInPage: mockRequestInPage,
    loadPlaywright: async () => ({ chromium }),
  });

  try {
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions(),
      ),
      /跳转到其他域名/,
    );
    assert.equal(requests, 1);
  } finally {
    await browserAuth.__stopBrowserBrokerForTests();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser authentication refuses a normal Chrome profile path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-profile-"));
  process.env.LANHU_BROWSER_PROFILE_DIR = path.join(
    root,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  let launches = 0;
  browserAuth.__setBrowserHooksForTests({
    sessionRoot: root,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => {
          launches += 1;
          throw new Error("should not launch");
        },
      },
    }),
  });

  try {
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions(),
      ),
      /不能使用日常 Chrome\/Edge 用户目录/,
    );
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser authentication refuses custom profiles outside its private session root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-root-"));
  const sessionRoot = path.join(root, "private-state");
  const outsideProfile = path.join(root, "shared", "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = outsideProfile;
  browserAuth.__setBrowserHooksForTests({
    sessionRoot,
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => { throw new Error("should not launch"); },
      },
    }),
  });

  try {
    await assert.rejects(
      browserAuth.__fetchLanhuJsonInBrowserForTests(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions(),
      ),
      /专用会话根目录/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

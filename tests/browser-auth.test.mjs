#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test.afterEach(async () => {
  await browserAuth.closeBrowserSession();
  browserAuth.__resetBrowserHooksForTests();
  delete process.env.LANHU_BROWSER_PROFILE_DIR;
  delete process.env.LANHU_NONINTERACTIVE;
});

test("first use opens a dedicated login browser and reuses its managed session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-browser-auth-"));
  const profile = path.join(root, "profile");
  process.env.LANHU_BROWSER_PROFILE_DIR = profile;

  const launches = [];
  const ignoredDefaults = [];
  const requests = [];
  const navigations = [];
  let loggedIn = false;

  const chromium = {
    launchPersistentContext: async (_profile, launchOptions) => {
      launches.push(launchOptions.headless);
      ignoredDefaults.push(launchOptions.ignoreDefaultArgs);
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
    loadPlaywright: async () => ({ chromium }),
    sleep: async () => {},
    stderr: () => {},
  });

  try {
    const result = await browserAuth.fetchLanhuJsonWithBrowser(
      "https://lanhuapp.com/api/project/images?project_id=p1",
      requestOptions(),
    );
    assert.equal(result.code, "00000");
    assert.deepEqual(launches, [false, true]);
    for (const ignored of ignoredDefaults) {
      assert.deepEqual(ignored, ["--password-store=basic", "--use-mock-keychain"]);
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
    await browserAuth.closeBrowserSession();
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
  browserAuth.__setBrowserHooksForTests({ loadPlaywright: async () => ({ chromium }) });

  try {
    await assert.rejects(
      browserAuth.fetchLanhuJsonWithBrowser(
        "https://lanhuapp.com/api/project/images?project_id=p1",
        requestOptions(),
      ),
      /跳转到其他域名/,
    );
    assert.equal(requests, 1);
  } finally {
    await browserAuth.closeBrowserSession();
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
      browserAuth.fetchLanhuJsonWithBrowser(
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

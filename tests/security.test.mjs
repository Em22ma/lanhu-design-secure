#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.LANHU_COOKIE = "session=top-secret";

const http = await import("../skills/lanhu-design-secure/scripts/secure-http.mjs");
const { downloadFile } = await import("../skills/lanhu-design-secure/scripts/lanhu-client.mjs");
const { atomicWriteFile, resolveInside } = await import("../skills/lanhu-design-secure/scripts/safe-files.mjs");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test.afterEach(() => {
  http.__resetNetworkHooksForTests();
});

test("sends Cookie only to exact authenticated API endpoints", async () => {
  const calls = [];
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return Response.json({ code: "00000", data: { images: [] } });
    },
  });

  await http.fetchLanhuJson("https://lanhuapp.com/api/project/images?project_id=p1");
  assert.equal(calls[0].headers.Cookie, "session=top-secret");

  await assert.rejects(
    http.fetchLanhuJson("https://attacker.example/api/project/images"),
    /非白名单端点/,
  );
  assert.equal(calls.length, 1);
});

test("never sends Cookie to server-supplied image hosts", async () => {
  const calls = [];
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  const result = await http.fetchImageBytes("https://alipic.lanhuapp.com/asset.png");
  assert.equal(result.buffer.length, png.length);
  assert.equal(Object.hasOwn(calls[0].headers, "Cookie"), false);
});

test("rejects an untrusted public resource host before fetch", async () => {
  let calls = 0;
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => {
      calls += 1;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  await assert.rejects(http.fetchImageBytes("https://attacker.example/asset.png"), /不在白名单/);
  assert.equal(calls, 0);
});

test("blocks cross-origin authenticated redirects before the second request", async () => {
  let calls = 0;
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/steal" },
      });
    },
  });
  await assert.rejects(
    http.fetchLanhuJson("https://lanhuapp.com/api/project/images?project_id=p1"),
    /跳转到其他域名/,
  );
  assert.equal(calls, 1);
});

test("revalidates resource redirects and rejects private IP targets", async () => {
  let calls = 0;
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal" },
      });
    },
  });
  await assert.rejects(http.fetchImageBytes("https://alipic.lanhuapp.com/start"), /白名单|私有、回环或保留/);
  assert.equal(calls, 1);
});

test("enforces response size and image validation", async () => {
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => new Response(Buffer.from("not-an-image"), {
      headers: {
        "content-type": "text/html",
        "content-length": String(64 * 1024 * 1024),
      },
    }),
  });
  await assert.rejects(http.fetchImageBytes("https://alipic.lanhuapp.com/huge"), /超过限制/);

  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => new Response(Buffer.from("not-an-image"), {
      headers: { "content-type": "text/html" },
    }),
  });
  await assert.rejects(http.fetchImageBytes("https://alipic.lanhuapp.com/html"), /不是受支持的图片/);
});

test("writes atomically and refuses silent overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-safe-files-"));
  try {
    const file = resolveInside(root, "asset.png");
    const first = await atomicWriteFile(file, png);
    assert.equal(first.changed, true);
    const same = await atomicWriteFile(file, png);
    assert.equal(same.changed, false);
    await assert.rejects(atomicWriteFile(file, Buffer.from("different")), /--force/);
    const replaced = await atomicWriteFile(file, Buffer.from("different"), { force: true });
    assert.equal(replaced.changed, true);
    assert.equal((await readFile(file)).toString(), "different");
    assert.throws(() => resolveInside(root, "../escape"), /越过允许目录/);
    const real = path.join(root, "real.txt");
    const linked = path.join(root, "linked.txt");
    await writeFile(real, "keep");
    await symlink(real, linked);
    await assert.rejects(
      atomicWriteFile(linked, "replace", { force: true, root }),
      /符号链接/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloadFile rejects file URLs and records a digest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lanhu-download-"));
  try {
    await assert.rejects(downloadFile("file:///etc/passwd", path.join(root, "bad.png")), /HTTPS/);
    http.__setNetworkHooksForTests({
      lookup: publicLookup,
      fetch: async (_url, options) => {
        assert.equal(Object.hasOwn(options.headers, "Cookie"), false);
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    const result = await downloadFile("https://alipic.lanhuapp.com/good.png", path.join(root, "good.png"));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

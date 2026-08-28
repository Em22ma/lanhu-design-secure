#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.LANHU_COOKIE = "session=top-secret";
process.env.LANHU_AUTH_MODE = "cookie";
process.env.LANHU_HTTP_TIMEOUT_MS = "1000";

const http = await import("../skills/lanhu-design-secure/scripts/secure-http.mjs");
const { downloadFile } = await import("../skills/lanhu-design-secure/scripts/lanhu-client.mjs");
const { atomicWriteFile, resolveInside } = await import("../skills/lanhu-design-secure/scripts/safe-files.mjs");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const TEST_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function testCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = TEST_CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithInvalidDeflateStream() {
  const damaged = Buffer.from(png);
  const idatOffset = 33;
  const length = damaged.readUInt32BE(idatOffset);
  damaged.fill(0, idatOffset + 8, idatOffset + 8 + length);
  damaged.writeUInt32BE(
    testCrc32(damaged.subarray(idatOffset + 4, idatOffset + 8 + length)),
    idatOffset + 8 + length,
  );
  return damaged;
}

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

test("pins a validated authoritative DNS fallback and safely sniffs generic OSS images", async () => {
  const calls = [];
  const lookupError = Object.assign(new Error("system resolver miss"), { code: "ENOTFOUND" });
  http.__setNetworkHooksForTests({
    lookup: async () => { throw lookupError; },
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => [],
    publicFetch: async (url, options, addresses) => {
      calls.push({ url: String(url), headers: options.headers, addresses });
      return new Response(png, { headers: { "content-type": "application/octet-stream" } });
    },
  });

  const result = await http.fetchImageBytes("https://alipic.lanhuapp.com/signed-asset");
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(calls[0].addresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(Object.hasOwn(calls[0].headers, "Cookie"), false);
});

test("returns when one authoritative DNS family never settles", async () => {
  const calls = [];
  const started = Date.now();
  http.__setNetworkHooksForTests({
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => new Promise(() => {}),
    publicFetch: async (_url, _options, addresses) => {
      calls.push(addresses);
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });

  const result = await http.fetchImageBytes("https://alipic.lanhuapp.com/dns-fallback.png");
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(calls, [[{ address: "93.184.216.34", family: 4 }]]);
  assert.ok(Date.now() - started < 900, "DNS fallback should finish before the total deadline");
});

test("cancels a pending native-style DNS handle so a CLI process can exit", () => {
  const moduleUrl = new URL(
    "../skills/lanhu-design-secure/scripts/secure-http.mjs",
    import.meta.url,
  ).href;
  const script = `
    process.env.NODE_ENV = "test";
    process.env.LANHU_AUTH_MODE = "cookie";
    process.env.LANHU_COOKIE = "test";
    const http = await import(${JSON.stringify(moduleUrl)});
    let activeHandle;
    http.__setNetworkHooksForTests({
      createResolver: () => ({
        resolve4: async () => ["93.184.216.34"],
        resolve6: async () => {
          activeHandle = setInterval(() => {}, 1000);
          return new Promise(() => {});
        },
        cancel: () => clearInterval(activeHandle),
      }),
      publicFetch: async () => new Response(
        Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64"),
        { headers: { "content-type": "image/png" } },
      ),
    });
    await http.fetchImageBytes("https://alipic.lanhuapp.com/cancel-dns.png");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("applies the total request deadline while every DNS source is pending", async () => {
  let fetched = false;
  const never = async () => new Promise(() => {});
  const started = Date.now();
  http.__setNetworkHooksForTests({
    lookup: never,
    resolve4: never,
    resolve6: never,
    publicFetch: async () => {
      fetched = true;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });

  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/dns-timeout.png"),
    /网络请求超过 1000 毫秒/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 2500, `unexpected timeout duration: ${elapsed}ms`);
  assert.equal(fetched, false);
});

test("keeps the same absolute deadline while reading the response body", async () => {
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    publicFetch: async () => new Response(new ReadableStream({
      pull: async () => new Promise(() => {}),
    }), { headers: { "content-type": "image/png" } }),
  });

  const started = Date.now();
  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/stalled-body.png"),
    /网络请求超过 1000 毫秒/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 2500, `unexpected body timeout: ${elapsed}ms`);
});

test("rejects IPv4 and IPv6 special-use DNS ranges by default", async () => {
  const specialUseAddresses = [
    ["127.0.0.1", 4],
    ["192.0.2.1", 4],
    ["::ffff:127.0.0.1", 6],
    ["fec0::1", 6],
    ["100::1", 6],
    ["64:ff9b::1", 6],
    ["2001::1", 6],
    ["2001:2::1", 6],
    ["2001:db8::1", 6],
    ["ff02::1", 6],
  ];

  for (const [address, family] of specialUseAddresses) {
    let fetched = false;
    http.__setNetworkHooksForTests({
      lookup: async () => [{ address, family }],
      publicFetch: async () => {
        fetched = true;
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    await assert.rejects(
      http.fetchImageBytes(`https://alipic.lanhuapp.com/special-${family}`),
      /私有、回环、保留或无效地址/,
      address,
    );
    assert.equal(fetched, false, address);
  }
});

test("rejects private addresses returned by the authoritative DNS fallback", async () => {
  let fetched = false;
  http.__setNetworkHooksForTests({
    lookup: async () => { throw new Error("system resolver miss"); },
    resolve4: async () => ["127.0.0.1"],
    resolve6: async () => [],
    publicFetch: async () => {
      fetched = true;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });

  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/private"),
    /私有、回环、保留或无效地址/,
  );
  assert.equal(fetched, false);
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

  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async () => new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), {
      headers: { "content-type": "image/png" },
    }),
  });
  await assert.rejects(http.fetchImageBytes("https://alipic.lanhuapp.com/truncated.png"), /不是受支持的图片/);

  const malformed = [
    {
      name: "missing-idat.png",
      type: "image/png",
      body: Buffer.concat([png.subarray(0, 33), png.subarray(56)]),
    },
    {
      name: "missing-scan.jpg",
      type: "image/jpeg",
      body: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]),
    },
    {
      name: "empty-vp8.webp",
      type: "image/webp",
      body: Buffer.from("524946460c000000574542505650382000000000", "hex"),
    },
    {
      name: "invalid-deflate.png",
      type: "image/png",
      body: pngWithInvalidDeflateStream(),
    },
    {
      name: "invalid-component.jpg",
      type: "image/jpeg",
      body: Buffer.from("ffd8ffc0000b080001000101011100ffda0008010200003f0000ffd9", "hex"),
    },
    {
      name: "invalid-lzw.gif",
      type: "image/gif",
      body: Buffer.from("474946383961010001000000002c000000000100010000020105003b", "hex"),
    },
    {
      name: "truncated-frame.webp",
      type: "image/webp",
      body: Buffer.from("524946461800000057454250565038200c0000000000009d012a010001000000", "hex"),
    },
  ];
  for (const fixture of malformed) {
    http.__setNetworkHooksForTests({
      lookup: publicLookup,
      fetch: async () => new Response(fixture.body, {
        headers: { "content-type": fixture.type },
      }),
    });
    await assert.rejects(
      http.fetchImageBytes(`https://alipic.lanhuapp.com/${fixture.name}`),
      /不是受支持的图片/,
      fixture.name,
    );
  }

  const validFormats = [
    { name: "pixel.png", type: "image/png", body: png },
    {
      name: "pixel.jpg",
      type: "image/jpeg",
      body: Buffer.from("/9j//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAEAAQMBEgACEgADEgD/2gAMAwEAAhEDEQA/AJ/AB//Z", "base64"),
    },
    {
      name: "pixel.gif",
      type: "image/gif",
      body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    },
    {
      name: "pixel.webp",
      type: "image/webp",
      body: Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=", "base64"),
    },
  ];
  for (const fixture of validFormats) {
    http.__setNetworkHooksForTests({
      lookup: publicLookup,
      fetch: async () => new Response(fixture.body, {
        headers: { "content-type": fixture.type },
      }),
    });
    const result = await http.fetchImageBytes(`https://alipic.lanhuapp.com/${fixture.name}`);
    assert.deepEqual(result.buffer, fixture.body);
  }
});

test("rejects SVG assets instead of attempting regex sanitization", async () => {
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async (url) => {
      const name = new URL(url).pathname;
      const body = name.includes("namespace")
        ? '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>'
        : name.includes("smil")
          ? '<svg xmlns="http://www.w3.org/2000/svg"><image id="i"/><set href="#i" attributeName="href" to="https://attacker.example/pixel"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#fff"/></svg>';
      return new Response(Buffer.from(body), {
        headers: { "content-type": "image/svg+xml" },
      });
    },
  });

  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/safe.svg"),
    /不是受支持的图片/,
  );
  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/namespace.svg"),
    /不是受支持的图片/,
  );
  await assert.rejects(
    http.fetchImageBytes("https://alipic.lanhuapp.com/smil.svg"),
    /不是受支持的图片/,
  );
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

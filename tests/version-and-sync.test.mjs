#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.LANHU_COOKIE = "session=version-test";
process.env.LANHU_AUTH_MODE = "cookie";

const http = await import("../skills/lanhu-design-secure/scripts/secure-http.mjs");
const { getDesignSchema } = await import("../skills/lanhu-design-secure/scripts/lanhu-client.mjs");
const { syncProject } = await import("../skills/lanhu-design-secure/scripts/sync_project.mjs");

const projectUrl = "https://lanhuapp.com/web/#/item/project/stage?pid=p1&tid=t1";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function installLanhuFixture({ latest = "v2", calls = [] } = {}) {
  http.__setNetworkHooksForTests({
    lookup: publicLookup,
    fetch: async (url, options) => {
      const href = String(url);
      calls.push({ href, headers: options.headers });
      if (href.includes("/api/project/images")) {
        return Response.json({
          code: "00000",
          data: {
            name: "Project",
            images: [{
              id: "d1",
              name: "Home",
              width: 375,
              height: 667,
              url: `https://alipic.lanhuapp.com/${latest}.png`,
              update_time: "2026-08-28T00:00:00Z",
            }],
          },
        });
      }
      if (href.includes("/api/project/multi_info")) {
        return Response.json({ code: "00000", data: { images: [{ id: "d1", latest_version: latest }] } });
      }
      if (href.includes("/api/project/image")) {
        return Response.json({
          code: "00000",
          result: {
            versions: [
              { id: "v2", json_url: "https://alipic.lanhuapp.com/v2.json", url: "https://alipic.lanhuapp.com/v2.png" },
              { id: "v1", json_url: "https://alipic.lanhuapp.com/v1.json", url: "https://alipic.lanhuapp.com/v1.png" },
            ],
          },
        });
      }
      if (href.includes("store_schema_revise")) {
        return Response.json({ code: "DDS_UNAVAILABLE", message: "fixture fallback" });
      }
      if (href.endsWith(".json")) {
        const version = href.includes("v1") ? "v1" : "v2";
        return Response.json({
          version,
          artboard: {
            name: "Home",
            frame: { width: 375, height: 667 },
            layers: [],
          },
        });
      }
      if (href.endsWith(".png")) {
        return new Response(png, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`Unexpected fixture URL: ${href}`);
    },
  });
}

test.afterEach(() => {
  http.__resetNetworkHooksForTests();
});

test("pins Sketch and DDS lookup to the requested version", async () => {
  const calls = [];
  installLanhuFixture({ latest: "v2", calls });
  const result = await getDesignSchema(projectUrl, "Home", { versionId: "v1" });
  assert.equal(result.versionId, "v1");
  assert.equal(result.sketchData.version, "v1");
  assert.equal(result.source, "sketch");
  assert.match(result.ddsError, /store_schema_revise/);
  assert.ok(calls.some(({ href }) => href.includes("version_id=v1")));
  for (const call of calls.filter(({ href }) => href.startsWith("https://alipic.lanhuapp.com"))) {
    assert.equal(Object.hasOwn(call.headers, "Cookie"), false);
  }
});

test("rejects an unavailable version instead of silently using latest", async () => {
  installLanhuFixture({ latest: "v2" });
  await assert.rejects(
    getDesignSchema(projectUrl, "Home", { versionId: "missing" }),
    /没有版本 missing/,
  );
});

test("syncs once, verifies hashes, and skips unchanged versions", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "lanhu-sync-"));
  try {
    installLanhuFixture({ latest: "v2" });
    const first = await syncProject({
      url: projectUrl,
      output,
      designs: "all",
      scale: "2x",
      versionId: "",
      force: false,
    });
    assert.equal(first.changed.length, 1);
    assert.equal(first.skipped.length, 0);
    const manifestPath = path.join(output, "lanhu-manifest.json");
    const firstStat = await stat(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.designs.d1.version, "v2");
    assert.ok(manifest.designs.d1.files.length >= 4);

    for (const file of manifest.designs.d1.files) {
      const absolute = path.resolve(output, file.path);
      assert.ok(absolute.startsWith(`${path.resolve(output)}${path.sep}`));
      await stat(absolute);
    }
    const savedSpecs = manifest.designs.d1.files.find((file) => file.kind === "spec-json");
    const specsText = await readFile(path.resolve(output, savedSpecs.path), "utf8");
    assert.doesNotMatch(specsText, /https:\/\/alipic\.lanhuapp\.com/);

    installLanhuFixture({ latest: "v2" });
    const second = await syncProject({
      url: projectUrl,
      output,
      designs: "all",
      scale: "2x",
      versionId: "",
      force: false,
    });
    assert.equal(second.changed.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.manifest_changed, false);
    const secondStat = await stat(manifestPath);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

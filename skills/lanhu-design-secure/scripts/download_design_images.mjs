#!/usr/bin/env node

import path from "node:path";
import { getDesigns, resolveDesignVersion, downloadFile } from "./lanhu-client.mjs";
import { resolveInside } from "./safe-files.mjs";
import { closeAuthenticatedSession } from "./secure-http.mjs";

function usage() {
  return (
    'usage: node scripts/download_design_images.mjs <lanhu_url> --designs <names> --output <dir> [--version-id <id>] [--force]\n\n' +
    '示例:\n' +
    '  node scripts/download_design_images.mjs "https://lanhuapp.com/..." --designs "1,2,3" --output ./tmp/designs\n' +
    '  node scripts/download_design_images.mjs "https://lanhuapp.com/..." --designs all --output ./designs\n' +
    '  node scripts/download_design_images.mjs "https://lanhuapp.com/..." --designs "首页设计" --output ./designs'
  );
}

const args = process.argv.slice(2);
let url = "";
let designsArg = "";
let outputDir = "";
let versionId = "";
let force = false;

const positionals = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    console.log(usage());
    process.exit(0);
  } else if (arg === "--designs") {
    designsArg = args[++i] || "";
  } else if (arg === "--output") {
    outputDir = args[++i] || "";
  } else if (arg === "--version-id") {
    versionId = args[++i] || "";
  } else if (arg === "--force") {
    force = true;
  } else if (!arg.startsWith("--")) {
    positionals.push(arg);
  } else {
    console.error(`未知参数: ${arg}`);
    process.exit(2);
  }
}

url = positionals[0] || "";

if (!url || !designsArg || !outputDir) {
  console.error(usage());
  process.exit(2);
}

function safeName(name) {
  return name
    .replace(/[^A-Za-z0-9一-鿿._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    || "design";
}

function extensionFromUrl(imgUrl, fallback = ".png") {
  try {
    const parsed = new URL(imgUrl);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return ext;
  } catch { /* ignore */ }
  return fallback;
}

try {
  const designsResult = await getDesigns(url);
  if (designsResult.status !== "success") {
    throw new Error(designsResult.message || "获取设计图列表失败。");
  }

  const allDesigns = designsResult.designs;
  let targets;

  if (designsArg.toLowerCase() === "all") {
    targets = allDesigns;
  } else {
    const selectors = designsArg.split(",").map((s) => s.trim()).filter(Boolean);
    targets = [];
    for (const sel of selectors) {
      const asNum = Number(sel);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= allDesigns.length) {
        targets.push(allDesigns[asNum - 1]);
        continue;
      }
      const exact = allDesigns.find((d) => d.name === sel);
      if (exact) {
        targets.push(exact);
        continue;
      }
      const partial = allDesigns.filter((d) => d.name.includes(sel));
      if (partial.length === 1) {
        targets.push(partial[0]);
      } else if (partial.length > 1) {
        throw new Error(
          `"${sel}" 匹配到多个设计图：${partial.map((d) => d.name).join(", ")}`,
        );
      } else {
        throw new Error(
          `未找到设计图 "${sel}"。可用：${allDesigns.map((d) => `${d.index}. ${d.name}`).join(", ")}`,
        );
      }
    }
  }

  if (targets.length === 0) {
    throw new Error("没有匹配到任何设计图。");
  }
  if (versionId && targets.length !== 1) {
    throw new Error("--version-id 只能与单个设计图一起使用，避免把一个版本 ID 错套到多个设计图。");
  }

  const downloaded = [];
  const failed = [];
  const outputRoot = path.resolve(outputDir);

  for (const design of targets) {
    try {
      const resolved = await resolveDesignVersion(url, design.name, { versionId });
      const ext = extensionFromUrl(resolved.designImageUrl);
      const filename = `${safeName(design.name)}${ext}`;
      const outputPath = resolveInside(outputRoot, filename);
      const file = await downloadFile(resolved.designImageUrl, outputPath, { force, outputRoot });
      downloaded.push({
        name: design.name,
        version: resolved.versionId,
        path: outputPath,
        sha256: file.sha256,
        bytes: file.bytes,
        changed: file.changed,
      });
      console.log(`OK ${outputPath}`);
    } catch (error) {
      failed.push({ name: design.name, reason: error.message });
      console.error(`FAIL ${design.name}: ${error.message}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        total: targets.length,
        downloaded: downloaded.length,
        failed: failed.length,
        files: downloaded,
        failures: failed,
        output: outputDir,
      },
      null,
      2,
    ),
  );

  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "error", message: error.message }));
  process.exitCode = 1;
} finally {
  await closeAuthenticatedSession();
}

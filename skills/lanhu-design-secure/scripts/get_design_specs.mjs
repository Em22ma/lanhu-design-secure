#!/usr/bin/env node

import path from "node:path";
import { getDesignSchema, downloadFile } from "./lanhu-client.mjs";
import { atomicWriteFile, atomicWriteJson, resolveInside } from "./safe-files.mjs";
import { buildDesignSpecs } from "./design-specs.mjs";
import { minifyHtml } from "./design-converter.mjs";
import { closeAuthenticatedSession } from "./secure-http.mjs";

function usage() {
  return `usage: node scripts/get_design_specs.mjs <lanhu_url> --design <name_or_index> [--version-id <id>] [--output <dir>] [--no-minify] [--download-images] [--referer <url>] [--force]

输出包含精确 HTML+CSS 规格的 JSON，可直接用于设计还原。
指定 --output 且加 --download-images 时，自动把 HTML 引用的图片下载到 <dir>/assets/slices/，使 HTML 可直接渲染。

示例:
  node scripts/get_design_specs.mjs "https://lanhuapp.com/..." --design "首页设计"
  node scripts/get_design_specs.mjs "https://lanhuapp.com/..." --design 1 --output ./tmp/specs --download-images`;
}

const argv = process.argv.slice(2);
let url = "";
let designArg = "";
let outputDir = "";
let doMinify = true;
let downloadImages = false;
let referer = "";
let versionId = "";
let force = false;

const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-h" || arg === "--help") { console.log(usage()); process.exit(0); }
  else if (arg === "--design") { designArg = argv[++i] || ""; }
  else if (arg === "--output") { outputDir = argv[++i] || ""; }
  else if (arg === "--no-minify") { doMinify = false; }
  else if (arg === "--download-images") { downloadImages = true; }
  else if (arg === "--referer") { referer = argv[++i] || ""; }
  else if (arg === "--version-id") { versionId = argv[++i] || ""; }
  else if (arg === "--force") { force = true; }
  else if (arg.startsWith("--")) { console.error(`未知参数: ${arg}`); process.exit(2); }
  else positionals.push(arg);
}

url = positionals[0] || "";

if (!url || !designArg) {
  console.error(usage());
  process.exit(2);
}

try {
  const schemaResult = await getDesignSchema(url, designArg, { versionId });
  const { design } = schemaResult;
  const result = buildDesignSpecs(schemaResult, { minify: doMinify });
  const html = result.html;
  const imageUrlMapping = result.image_url_mapping;

  if (outputDir) {
    const outputRoot = path.resolve(outputDir);
    const safeName = design.name.replace(/[^A-Za-z0-9一-鿿._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "design";
    const jsonPath = resolveInside(outputRoot, `${safeName}_specs.json`);
    const htmlPath = resolveInside(outputRoot, `${safeName}.html`);

    if (downloadImages) {
      const entries = Object.entries(imageUrlMapping);
      const ref = referer || "https://lanhuapp.com/";
      let ok = 0;
      const failed = [];
      const assetFiles = [];
      for (const [localPath, remoteUrl] of entries) {
        const dest = resolveInside(outputRoot, localPath);
        try {
          const downloaded = await downloadFile(remoteUrl, dest, { referer: ref, force, outputRoot });
          ok += 1;
          assetFiles.push({ path: dest, sha256: downloaded.sha256, bytes: downloaded.bytes });
        } catch (err) {
          failed.push(`${localPath}: ${err.message}`);
        }
      }
      result.images_downloaded = ok;
      result.images_failed = failed;
      result.asset_files = assetFiles;
      console.error(`已下载图片: ${ok}/${entries.length}` + (failed.length ? `，失败 ${failed.length}` : ""));
      for (const f of failed) console.error(`  下载失败 ${f}`);
    }

    const htmlWrite = await atomicWriteFile(htmlPath, doMinify ? minifyHtml(html) : html, { force, root: outputRoot });
    const jsonWrite = await atomicWriteJson(jsonPath, result, { force, root: outputRoot });
    console.error(`已保存规格 JSON: ${jsonPath} (${jsonWrite.sha256})`);
    console.error(`已保存 HTML: ${htmlPath} (${htmlWrite.sha256})`);
  } else if (downloadImages) {
    console.error("提示：--download-images 需要配合 --output 使用，已忽略。");
  }

  console.log(JSON.stringify(result, null, 2));
  if (Array.isArray(result.images_failed) && result.images_failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "error", message: error.message }));
  process.exitCode = 1;
} finally {
  await closeAuthenticatedSession();
}

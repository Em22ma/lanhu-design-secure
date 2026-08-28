#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  downloadFile,
  getDesignSchema,
  getDesignSlicesInfo,
  getDesigns,
  parseUrl,
  resolveDesignVersion,
} from "./lanhu-client.mjs";
import { buildDesignSpecs } from "./design-specs.mjs";
import { downloadSlicesData } from "./download_slices.mjs";
import { atomicWriteFile, atomicWriteJson, resolveInside, sha256 } from "./safe-files.mjs";
import { closeAuthenticatedSession } from "./secure-http.mjs";

const MANIFEST_VERSION = 1;

function usage() {
  return `usage: node scripts/sync_project.mjs <lanhu_url> [--output ./.lanhu] [--designs all|1,2|name] [--scale 2x] [--version-id <id>] [--force]

增量同步设计图原图、同版本规格、切图元数据与切图文件，并维护 lanhu-manifest.json。

示例:
  node scripts/sync_project.mjs "https://lanhuapp.com/web/#/item/project/stage?pid=...&tid=..."
  node scripts/sync_project.mjs "https://lanhuapp.com/..." --designs "1,首页" --scale 2x`;
}

function parseArgs(argv) {
  const args = {
    url: "",
    output: ".lanhu",
    designs: "all",
    scale: "2x",
    versionId: "",
    force: false,
  };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--output") args.output = argv[++index] || "";
    else if (arg === "--designs") args.designs = argv[++index] || "";
    else if (arg === "--scale") args.scale = argv[++index] || "";
    else if (arg === "--version-id") args.versionId = argv[++index] || "";
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--")) throw new Error(`未知参数: ${arg}`);
    else positionals.push(arg);
  }
  args.url = positionals[0] || "";
  if (positionals.length > 1) throw new Error("只允许一个蓝湖项目 URL。");
  return args;
}

function safeStem(value, fallback = "item") {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .replace(/[^A-Za-z0-9一-鿿._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || fallback;
}

function extensionFromUrl(url) {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return extension;
  } catch {
    // The secure downloader will report malformed URLs.
  }
  return ".png";
}

function selectDesigns(designs, selector) {
  if (selector.toLowerCase() === "all") return designs;
  const selected = [];
  const seen = new Set();
  for (const token of selector.split(",").map((item) => item.trim()).filter(Boolean)) {
    const index = Number(token);
    let match;
    if (Number.isInteger(index) && index >= 1 && index <= designs.length) {
      match = designs[index - 1];
    } else {
      match = designs.find((design) => design.name === token);
      if (!match) {
        const partial = designs.filter((design) => design.name.includes(token));
        if (partial.length > 1) throw new Error(`"${token}" 匹配多个设计图，请使用完整名称或序号。`);
        match = partial[0];
      }
    }
    if (!match) throw new Error(`未找到设计图 "${token}"。`);
    if (!seen.has(String(match.id))) {
      seen.add(String(match.id));
      selected.push(match);
    }
  }
  if (selected.length === 0) throw new Error("没有选择任何设计图。");
  return selected;
}

async function loadManifest(manifestPath, projectId) {
  try {
    const raw = await readFile(manifestPath);
    if (raw.length > 5 * 1024 * 1024) throw new Error("现有 manifest 超过 5 MiB，拒绝读取。");
    const manifest = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
    if (manifest.schema_version !== MANIFEST_VERSION) {
      throw new Error(`不支持 manifest schema_version=${manifest.schema_version}。`);
    }
    if (String(manifest.project_id) !== String(projectId)) {
      throw new Error("输出目录属于另一个蓝湖项目，拒绝混写。");
    }
    if (!manifest.designs || typeof manifest.designs !== "object" || Array.isArray(manifest.designs)) {
      throw new Error("manifest.designs 格式无效。");
    }
    return manifest;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schema_version: MANIFEST_VERSION, project_id: projectId, designs: {} };
    }
    throw error;
  }
}

function relativeRecord(outputRoot, writeResult, kind) {
  return {
    kind,
    path: path.relative(outputRoot, writeResult.path).split(path.sep).join("/"),
    sha256: writeResult.sha256,
    bytes: writeResult.bytes,
  };
}

async function filesMatch(outputRoot, files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  for (const file of files) {
    try {
      const filePath = resolveInside(outputRoot, file.path);
      const bytes = await readFile(filePath);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function withoutRemoteUrls(value) {
  if (Array.isArray(value)) return value.map(withoutRemoteUrls);
  if (!value || typeof value !== "object") return value;
  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (["download_url", "scale_urls", "svg_url", "json_url", "url"].includes(key)) continue;
    cleaned[key] = withoutRemoteUrls(child);
  }
  return cleaned;
}

async function syncDesign({ url, design, context, outputRoot, scale, force }) {
  const designStem = safeStem(design.name, `design_${design.index}`);
  const idStem = safeStem(design.id, `design_${design.index}`);
  const versionStem = safeStem(context.versionId, "version");
  const versionRoot = resolveInside(outputRoot, path.join("versions", idStem, versionStem));
  const files = [];

  const screenshotPath = resolveInside(
    versionRoot,
    path.join("design", `${designStem}${extensionFromUrl(context.designImageUrl)}`),
  );
  const screenshot = await downloadFile(context.designImageUrl, screenshotPath, { force, outputRoot });
  files.push(relativeRecord(outputRoot, screenshot, "design-image"));

  const schemaResult = await getDesignSchema(url, design.name, { context });
  const specs = buildDesignSpecs(schemaResult, { minify: false });
  const mapping = specs.image_url_mapping;
  const localizedAssets = [];
  for (const [localPath, remoteUrl] of Object.entries(mapping)) {
    const destination = resolveInside(resolveInside(versionRoot, "specs"), localPath);
    const downloaded = await downloadFile(remoteUrl, destination, {
      referer: "https://lanhuapp.com/",
      force,
      outputRoot,
    });
    const record = relativeRecord(outputRoot, downloaded, "spec-image");
    files.push(record);
    localizedAssets.push(record.path);
  }

  const specsForDisk = {
    ...specs,
    image_url_mapping: Object.keys(mapping),
    localized_assets: localizedAssets,
  };
  const specsRoot = resolveInside(versionRoot, "specs");
  const htmlWrite = await atomicWriteFile(resolveInside(specsRoot, `${designStem}.html`), specs.html, { force, root: outputRoot });
  const specsWrite = await atomicWriteJson(resolveInside(specsRoot, `${designStem}_specs.json`), specsForDisk, { force, root: outputRoot });
  files.push(relativeRecord(outputRoot, htmlWrite, "spec-html"));
  files.push(relativeRecord(outputRoot, specsWrite, "spec-json"));

  const slices = await getDesignSlicesInfo(url, design.name, true, { context });
  let sliceSummary = {
    slices: slices.total_slices,
    planned_files: 0,
    downloaded: 0,
    missing_url: 0,
    failed: 0,
    files: [],
    failures: [],
  };
  if (slices.total_slices > 0) {
    sliceSummary = await downloadSlicesData(slices, {
      output: resolveInside(versionRoot, path.join("slices", "assets")),
      scale,
      referer: "https://lanhuapp.com/",
      retries: 2,
      force,
    });
    if (sliceSummary.failed > 0) {
      throw new Error(`切图下载失败 ${sliceSummary.failed} 项: ${sliceSummary.failures.join("; ")}`);
    }
    for (const file of sliceSummary.files) files.push(relativeRecord(outputRoot, file, "slice"));
  }

  const slicesForDisk = withoutRemoteUrls({
    ...slices,
    downloaded_scale: scale,
    downloaded_files: sliceSummary.files.map((file) =>
      path.relative(outputRoot, file.path).split(path.sep).join("/")),
  });
  const slicesWrite = await atomicWriteJson(
    resolveInside(versionRoot, path.join("slices", `${designStem}_slices.json`)),
    slicesForDisk,
    { force, root: outputRoot },
  );
  files.push(relativeRecord(outputRoot, slicesWrite, "slice-metadata"));

  return {
    id: String(design.id),
    name: design.name,
    index: design.index,
    version: context.versionId,
    source: specs.source,
    update_time: design.update_time || null,
    synced_at: new Date().toISOString(),
    scale,
    files,
  };
}

export async function syncProject(args) {
  if (!args.url || !args.output || !args.designs || !args.scale) {
    throw new Error("url、output、designs 和 scale 均为必填配置。");
  }

  const project = parseUrl(args.url);
  const outputRoot = path.resolve(args.output);
  const manifestPath = resolveInside(outputRoot, "lanhu-manifest.json");
  const manifest = await loadManifest(manifestPath, project.project_id);
  const designsResult = await getDesigns(args.url);
  if (designsResult.status !== "success") throw new Error(designsResult.message || "获取设计图列表失败。");
  const targets = selectDesigns(designsResult.designs, args.designs);
  const pinnedVersion = args.versionId || project.version_id || "";
  if (pinnedVersion && targets.length !== 1) {
    throw new Error("版本 ID 只能用于单个设计图，避免跨设计图混用版本。");
  }

  const changed = [];
  const skipped = [];
  const nextManifest = structuredClone(manifest);
  nextManifest.project_name = designsResult.project_name;
  nextManifest.team_id = project.team_id || null;
  nextManifest.scale = args.scale;

  for (const design of targets) {
    const context = await resolveDesignVersion(args.url, design.name, { versionId: pinnedVersion });
    const existing = manifest.designs[String(design.id)];
    if (existing?.version === context.versionId && await filesMatch(outputRoot, existing.files)) {
      skipped.push({ id: String(design.id), name: design.name, version: context.versionId });
      continue;
    }
    const entry = await syncDesign({
      url: args.url,
      design,
      context,
      outputRoot,
      scale: args.scale,
      force: args.force,
    });
    nextManifest.designs[String(design.id)] = entry;
    changed.push({ id: entry.id, name: entry.name, version: entry.version, source: entry.source });
  }

  let manifestChanged = false;
  if (changed.length > 0) {
    nextManifest.updated_at = new Date().toISOString();
    await atomicWriteJson(manifestPath, nextManifest, { force: true, mode: 0o600, root: outputRoot });
    manifestChanged = true;
  }

  return {
    status: "success",
    project_id: project.project_id,
    project_name: designsResult.project_name,
    selected: targets.length,
    changed,
    skipped,
    manifest: manifestPath,
    manifest_changed: manifestChanged,
    output: outputRoot,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.url || !args.output || !args.designs || !args.scale) {
    console.error(usage());
    return 2;
  }
  const result = await syncProject(args);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ status: "error", message: error.message }));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeAuthenticatedSession();
    });
}

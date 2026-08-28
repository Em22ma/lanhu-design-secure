#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { downloadFile } from "./lanhu-client.mjs";
import { resolveInside } from "./safe-files.mjs";

const SCALE_GROUPS = {
  "ios-all": [
    ["ios_1x", ""],
    ["ios_2x", "@2x"],
    ["ios_3x", "@3x"],
  ],
  "android-all": [
    ["android_mdpi", "mipmap-mdpi"],
    ["android_hdpi", "mipmap-hdpi"],
    ["android_xhdpi", "mipmap-xhdpi"],
    ["android_xxhdpi", "mipmap-xxhdpi"],
    ["android_xxxhdpi", "mipmap-xxxhdpi"],
  ],
};

const SINGLE_SCALE_SUFFIX = {
  "1x": "",
  "2x": "@2x",
  "3x": "@3x",
  ios_1x: "",
  ios_2x: "@2x",
  ios_3x: "@3x",
  android_mdpi: "",
  android_hdpi: "",
  android_xhdpi: "",
  android_xxhdpi: "",
  android_xxxhdpi: "",
};

const VALID_SCALES = new Set([
  ...Object.keys(SINGLE_SCALE_SUFFIX),
  ...Object.keys(SCALE_GROUPS),
]);

function usage() {
  return `usage: node scripts/download_slices.mjs <json_file> --output <dir> [--scale 2x] [--name-map names.json] [--referer https://lanhuapp.com/] [--retries 2] [--force]

Download Lanhu design slices from lanhu_get_design_slices JSON output.`;
}

function parseArgs(argv) {
  const args = {
    jsonFile: "",
    output: "",
    scale: "2x",
    nameMap: "",
    referer: "",
    retries: 2,
    force: false,
  };

  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--output") {
      args.output = argv[++index] || "";
    } else if (arg === "--scale") {
      args.scale = argv[++index] || "2x";
    } else if (arg === "--name-map") {
      args.nameMap = argv[++index] || "";
    } else if (arg === "--referer") {
      args.referer = argv[++index] || "";
    } else if (arg === "--retries") {
      args.retries = Number.parseInt(argv[++index] || "2", 10);
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  args.jsonFile = positionals[0] || "";
  if (!Number.isInteger(args.retries) || args.retries < 0) {
    throw new Error("--retries must be a non-negative integer.");
  }
  if (!VALID_SCALES.has(args.scale)) {
    throw new Error(`--scale must be one of: ${Array.from(VALID_SCALES).join(", ")}`);
  }
  return args;
}

async function loadJson(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`JSON input is not a regular file: ${filePath}`);
  if (info.size > 25 * 1024 * 1024) throw new Error(`JSON input exceeds 25 MiB: ${filePath}`);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function findSlices(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findSlices(item);
      if (found.length > 0) return found;
    }
    return [];
  }

  if (data && typeof data === "object") {
    if (Array.isArray(data.slices)) return data.slices;
    for (const value of Object.values(data)) {
      const found = findSlices(value);
      if (found.length > 0) return found;
    }
  }

  return [];
}

function safeStem(value, fallback) {
  const leaf = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const cleaned = leaf
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || fallback;
}

function extensionFromUrl(url, fallback = ".png") {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
      return ext;
    }
  } catch {
    const clean = String(url).split(/[?#]/, 1)[0];
    const ext = path.extname(clean).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
      return ext;
    }
  }
  return fallback;
}

function nameForSlice(item, index, nameMap) {
  const keys = [
    String(item.id || ""),
    String(item.layer_path || ""),
    String(item.name || ""),
  ];
  for (const key of keys) {
    if (key && Object.hasOwn(nameMap, key)) {
      return safeStem(nameMap[key], `slice_${String(index).padStart(3, "0")}`);
    }
  }
  return safeStem(
    item.name || item.layer_path || "",
    `slice_${String(index).padStart(3, "0")}`,
  );
}

function urlForScale(item, scale) {
  const scaleUrls = item.scale_urls && typeof item.scale_urls === "object"
    ? item.scale_urls
    : {};
  if (scaleUrls[scale]) return String(scaleUrls[scale]);
  if (scale === "2x" && item.download_url) return String(item.download_url);
  return "";
}

function buildTargets(item, index, scale, outputDir, nameMap) {
  const stem = nameForSlice(item, index, nameMap);
  const targets = [];

  if (Object.hasOwn(SCALE_GROUPS, scale)) {
    for (const [scaleKey, suffixOrDir] of SCALE_GROUPS[scale]) {
      const url = urlForScale(item, scaleKey);
      if (!url) continue;
      const ext = extensionFromUrl(url);
      const outputPath = scale === "android-all"
        ? resolveInside(outputDir, path.join(suffixOrDir, `${stem}${ext}`))
        : resolveInside(outputDir, `${stem}${suffixOrDir}${ext}`);
      targets.push({ url, outputPath });
    }
    return targets;
  }

  const url = urlForScale(item, scale);
  if (!url) return targets;
  const ext = extensionFromUrl(url);
  const suffix = SINGLE_SCALE_SUFFIX[scale] || "";
  targets.push({ url, outputPath: resolveInside(outputDir, `${stem}${suffix}${ext}`) });
  return targets;
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download(url, outputPath, referer, retries, force, outputRoot) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await downloadFile(url, outputPath, { referer, force, outputRoot });
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(500 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function downloadSlicesData(data, options) {
  const slices = findSlices(data);
  if (slices.length === 0) {
    throw new Error("No slices found in JSON.");
  }
  const args = {
    output: options.output,
    scale: options.scale || "2x",
    referer: options.referer || "",
    retries: options.retries ?? 2,
    force: Boolean(options.force),
  };
  if (!VALID_SCALES.has(args.scale)) {
    throw new Error(`--scale must be one of: ${Array.from(VALID_SCALES).join(", ")}`);
  }
  const nameMap = options.nameMap || {};
  if (!nameMap || typeof nameMap !== "object" || Array.isArray(nameMap)) {
    throw new Error("--name-map must be a JSON object.");
  }

  const outputRoot = path.resolve(args.output);
  const planned = [];
  let missing = 0;
  slices.forEach((item, itemIndex) => {
    const targets = buildTargets(item, itemIndex + 1, args.scale, outputRoot, nameMap);
    if (targets.length === 0) {
      missing += 1;
      return;
    }
    const label = String(item.layer_path || item.name || item.id || itemIndex + 1);
    for (const target of targets) {
      planned.push({ ...target, label });
    }
  });
  if (planned.length === 0) {
    throw new Error(
      `No downloadable URLs found for scale "${args.scale}". This scale requires scale_urls; download_url only maps to 2x.`,
    );
  }

  const failures = [];
  const files = [];
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index];
    try {
      const result = await download(item.url, item.outputPath, args.referer, args.retries, args.force, outputRoot);
      files.push({
        path: item.outputPath,
        sha256: result.sha256,
        bytes: result.bytes,
        changed: result.changed,
      });
      options.onProgress?.({ status: "ok", index: index + 1, total: planned.length, path: item.outputPath });
    } catch (error) {
      failures.push(`${item.label} -> ${item.outputPath}: ${error.message}`);
      options.onProgress?.({ status: "failed", index: index + 1, total: planned.length, path: item.outputPath });
    }
  }

  return {
    slices: slices.length,
    planned_files: planned.length,
    downloaded: planned.length - failures.length,
    missing_url: missing,
    failed: failures.length,
    output: outputRoot,
    files,
    failures,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.jsonFile || !args.output) {
    console.error(usage());
    return 2;
  }

  const data = await loadJson(args.jsonFile);
  const nameMap = args.nameMap ? await loadJson(args.nameMap) : {};
  const summary = await downloadSlicesData(data, {
    ...args,
    nameMap,
    onProgress: ({ status, index, total, path: filePath }) => {
      console[status === "ok" ? "log" : "error"](`[${index}/${total}] ${status.toUpperCase()} ${filePath}`);
    },
  });
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failures.length > 0) {
    console.error("Failures:");
    for (const failure of summary.failures) {
      console.error(`- ${failure}`);
    }
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

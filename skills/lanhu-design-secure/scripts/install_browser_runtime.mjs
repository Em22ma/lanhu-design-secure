#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log("usage: node scripts/install_browser_runtime.mjs\n\nInstall the exact locked browser and image-validation runtimes without lifecycle scripts.");
  process.exit(0);
}
if (process.argv.length > 2) {
  console.error("usage: node scripts/install_browser_runtime.mjs");
  process.exit(2);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: skillRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`npm 被信号 ${signal} 中止。`));
      else if (code !== 0) reject(new Error(`npm ci 失败，退出码 ${code}。`));
      else resolve();
    });
  });
}

try {
  await run("npm", [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  const runtime = await import("playwright-core");
  if (!runtime.chromium) throw new Error("playwright-core 安装后未提供 chromium。");
  const imageRuntime = await import("sharp");
  if (typeof imageRuntime.default !== "function") throw new Error("sharp 安装后未提供图片解码器。");
  const addressRuntime = await import("ipaddr.js");
  if (typeof addressRuntime.default?.parse !== "function") {
    throw new Error("ipaddr.js 安装后未提供 IP 地址分类器。");
  }
  console.log("蓝湖浏览器、IP 地址与图片校验运行时安装完成。Cookie 将由专用浏览器会话管理。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

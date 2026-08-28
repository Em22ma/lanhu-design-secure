#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";

const skillRoot = path.resolve(import.meta.dirname, "..");

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log("usage: node scripts/install_browser_runtime.mjs\n\nInstall the exact locked browser runtime without lifecycle scripts.");
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
  console.log("蓝湖浏览器运行时安装完成。Cookie 将由专用浏览器会话管理。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

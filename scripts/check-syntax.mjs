#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "lanhu-design-secure", "scripts");
for (const name of (await readdir(scripts)).filter((file) => file.endsWith(".mjs")).sort()) {
  const result = spawnSync(process.execPath, ["--check", path.join(scripts, name)], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}
console.log("syntax check passed");

#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "skills", "lanhu-design-secure");
const scriptsRoot = path.join(skillRoot, "scripts");

test("skill package has valid discovery metadata", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter);
  const fields = frontmatter[1]
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf(":")));
  assert.deepEqual(fields, ["name", "description"]);
  assert.match(frontmatter[1], /^name: lanhu-design-secure$/m);
  assert.match(frontmatter[1], /^description: .{40,}$/m);

  const openai = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(openai, /display_name: "Lanhu Design Secure"/);
  assert.match(openai, /default_prompt: ".*\$lanhu-design-secure/);
  await access(path.join(skillRoot, "LICENSE.txt"));

  const runtimePackage = JSON.parse(await readFile(path.join(skillRoot, "package.json"), "utf8"));
  const runtimeLock = JSON.parse(await readFile(path.join(skillRoot, "package-lock.json"), "utf8"));
  assert.equal(runtimePackage.dependencies["playwright-core"], "1.62.1");
  assert.equal(runtimeLock.packages["node_modules/playwright-core"].version, "1.62.1");
  assert.match(
    runtimeLock.packages["node_modules/playwright-core"].integrity,
    /^sha512-[A-Za-z0-9+/=]+$/,
  );
});

test("all command entry points expose help", async () => {
  for (const script of [
    "get_designs.mjs",
    "lanhu_login.mjs",
    "install_browser_runtime.mjs",
    "download_design_images.mjs",
    "get_design_specs.mjs",
    "get_design_slices.mjs",
    "download_slices.mjs",
    "sync_project.mjs",
  ]) {
    const result = spawnSync(process.execPath, [path.join(scriptsRoot, script), "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
    assert.match(result.stdout, /usage:/i);
  }
});

test("security-sensitive primitives stay centralized", async () => {
  const names = (await readdir(scriptsRoot)).filter((name) => name.endsWith(".mjs"));
  for (const name of names) {
    const source = await readFile(path.join(scriptsRoot, name), "utf8");
    assert.doesNotMatch(source, /redirect:\s*["']follow["']/);
    if (name !== "secure-http.mjs") assert.doesNotMatch(source, /\bCookie\s*:/);
    if (name !== "safe-files.mjs") assert.doesNotMatch(source, /\bwriteFile\s*\(/);
    assert.doesNotMatch(source, /\.cookies\s*\(/);
    assert.doesNotMatch(source, /\.storageState\s*\(/);
    assert.doesNotMatch(source, /cookie\.json/i);
  }
});

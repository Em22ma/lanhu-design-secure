#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function resolveInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`输出路径越过允许目录: ${candidate}`);
  }
  return resolved;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertNoNestedSymlink(root, filePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = resolveInside(resolvedRoot, path.relative(resolvedRoot, path.resolve(filePath)));
  const relative = path.relative(resolvedRoot, resolvedFile);
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`拒绝通过符号链接写入: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

export async function atomicWriteFile(filePath, data, { force = false, mode = 0o644, root = path.dirname(filePath) } = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const digest = sha256(buffer);
  await assertNoNestedSymlink(root, filePath);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });

  if (await exists(filePath)) {
    const current = await readFile(filePath);
    const currentDigest = sha256(current);
    if (currentDigest === digest) return { path: filePath, sha256: digest, bytes: buffer.length, changed: false };
    if (!force) throw new Error(`文件已存在且内容不同，使用 --force 才能覆盖: ${filePath}`);
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { path: filePath, sha256: digest, bytes: buffer.length, changed: true };
}

export async function atomicWriteJson(filePath, value, options = {}) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

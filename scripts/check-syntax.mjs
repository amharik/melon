#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["bin", "server", "scripts", "web", "extension", "test"];
const SKIP = new Set(["node_modules", "vendor", "wasm", "dist", ".git"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((dir) => {
  const full = path.join(ROOT, dir);
  return fs.existsSync(full) ? walk(full) : [];
});
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push({ file: path.relative(ROOT, file), error: (result.stderr || result.stdout).trim() });
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`\n${failure.file}\n${failure.error}`);
  console.error(`\n${failures.length} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`syntax ok: ${files.length} files`);

// Read-only shared blackboard. The file is owned by the user (or an external
// editor); the hub never writes it and never exposes an upload path.

import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 64 * 1024;

export function readBlackboard({ file } = {}) {
  if (!file) return { ok: false, path: null, text: "", error: "not configured" };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, path: file, text: "", error: "not a file" };
    if (stat.size > MAX_BYTES) return { ok: false, path: file, text: "", error: "file is too large" };
    return {
      ok: true,
      path: path.resolve(file),
      text: fs.readFileSync(file, "utf8"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    return { ok: false, path: path.resolve(file), text: "", error: err.code || err.message };
  }
}

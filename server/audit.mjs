import fs from "node:fs";
import path from "node:path";

const FIELDS = new Set([
  "event",
  "runId",
  "target",
  "node",
  "label",
  "adapter",
  "tabId",
  "controlId",
  "status",
  "durationMs",
  "chars",
  "timedOut",
]);

function clean(value) {
  const out = {};
  for (const field of FIELDS) {
    const item = value[field];
    if (item === null || item === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof item)) continue;
    out[field] = typeof item === "string" ? item.slice(0, 160) : item;
  }
  return out;
}

export function createAuditLog({ file = "", now = () => new Date() } = {}) {
  const enabled = Boolean(file);
  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  function write(event) {
    if (!enabled) return false;
    const line = JSON.stringify({ ts: now().toISOString(), ...clean(event) }) + "\n";
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  return { enabled, file, write };
}

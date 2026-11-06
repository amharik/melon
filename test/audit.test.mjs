import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditLog } from "../server/audit.mjs";

test("audit log writes metadata only and ignores prompts or output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-audit-"));
  const file = path.join(dir, "nested", "audit.jsonl");
  const audit = createAuditLog({ file, now: () => new Date("2026-01-02T03:04:05Z") });
  assert.equal(audit.enabled, true);
  assert.equal(audit.write({
    event: "run.end",
    runId: "run-1",
    target: "extension",
    node: "reviewer",
    adapter: "claude",
    tabId: 42,
    controlId: "T-16",
    status: "done",
    durationMs: 123,
    chars: 11,
    prompt: "secret prompt",
    text: "secret output",
  }), true);

  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.ts, "2026-01-02T03:04:05.000Z");
  assert.equal(record.runId, "run-1");
  assert.equal(record.controlId, "T-16");
  assert.equal(record.status, "done");
  assert.equal("prompt" in record, false);
  assert.equal("text" in record, false);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  await fs.rm(dir, { recursive: true, force: true });
});

test("audit log is off unless a path is provided", () => {
  const audit = createAuditLog();
  assert.equal(audit.enabled, false);
  assert.equal(audit.write({ event: "run.start", runId: "x" }), false);
});

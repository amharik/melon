import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTracer } from "../server/trace.mjs";

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "melon-trace-")), "traces.jsonl");
}

test("tracer writes bounded start and end spans with parent links", () => {
  const file = tempFile();
  const tracer = createTracer({ file });
  const root = tracer.span("run", { runId: "run-1", prompt: "secret", target: "demo", nested: { a: 1 } });
  const child = tracer.span("tool", { commandId: "tool-1", command: "echo secret" }, root);
  child.end({ status: "done", exitCode: 0, sandbox: "srt" });
  root.end({ status: "done", chars: 12 });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 4);
  const start = lines.find((line) => line.type === "span.start" && line.name === "run");
  const childEnd = lines.find((line) => line.type === "span.end" && line.name === "tool");
  assert.equal(start.attrs.runId, "run-1");
  assert.equal(start.attrs.prompt, undefined);
  assert.equal(start.attrs.nested, undefined);
  assert.equal(childEnd.parentSpanId, start.spanId);
  assert.equal(childEnd.attrs.exitCode, 0);
  assert.equal(childEnd.attrs.command, undefined);
  assert.equal(childEnd.status, "done");
  assert.ok(childEnd.durationMs >= 0);
});

test("tracer records errors once and ignores repeated ends", () => {
  const file = tempFile();
  const tracer = createTracer({ file });
  const span = tracer.span("run", { runId: "run-2" });
  span.error(new Error("boom"));
  span.end({ status: "done" });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].status, "error");
  assert.equal(lines[1].attrs.error, "boom");
});

test("tracer is a no-op when no file is configured", () => {
  const tracer = createTracer();
  const span = tracer.span("run", { runId: "run-3" });
  assert.equal(span.end({ status: "done" }), false);
  assert.equal(tracer.enabled, false);
});

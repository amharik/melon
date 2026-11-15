import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTelemetryTracker } from "../server/telemetry.mjs";

test("telemetry tracker records events and auto-diagnoses timeouts and adapter failures", () => {
  const tracker = createTelemetryTracker();

  const timeoutEv = tracker.record({
    subsystem: "extension",
    type: "adapter_timeout",
    message: "timed out waiting for a response from model",
    tabId: 101,
  });

  assert.equal(timeoutEv.level, "error");
  assert.equal(timeoutEv.tabId, 101);
  assert.ok(timeoutEv.diagnosis.includes("background tab throttling"));

  const adapterEv = tracker.record({
    subsystem: "adapter",
    type: "selector_missing",
    message: "cannot find composer div.ProseMirror",
    tabId: 102,
  });

  assert.ok(adapterEv.diagnosis.includes("Site DOM changed") || adapterEv.diagnosis.includes("login/CAPTCHA"));

  const list = tracker.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, adapterEv.id); // newest first
});

test("telemetry persists to file when configured", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-telemetry-"));
  const logFile = path.join(tmpDir, "telemetry.jsonl");

  const tracker = createTelemetryTracker({ file: logFile });
  tracker.record({ subsystem: "hub", message: "WASM ABI memory failure" });

  const content = await fs.readFile(logFile, "utf8");
  assert.ok(content.includes("WASM ABI memory failure"));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskStore } from "../server/tasks.mjs";
import { parseCliArgs } from "../bin/melon.mjs";

test("createTaskStore manages lifecycle and captures partial output on interrupt", () => {
  const store = createTaskStore();

  const task = store.create({
    id: "run_test_001",
    target: { type: "extension", tabId: 201, adapter: "chatgpt", prompt: "Write an async worker" },
  });

  assert.equal(task.id, "run_test_001");
  assert.equal(task.status, "queued");
  assert.equal(task.resumable, false);
  assert.equal(store.activeCount, 1);

  // Streaming updates
  store.update("run_test_001", { status: "streaming", text: "export async function worker() {" });
  const updated = store.get("run_test_001");
  assert.equal(updated.status, "streaming");
  assert.equal(updated.chars, 32);
  assert.ok(updated.durationMs >= 0);

  // Task interrupted / timed out
  const finished = store.finish("run_test_001", {
    status: "error",
    text: "export async function worker() {\n  const queue = [];",
    error: "timed out waiting for response",
  });

  assert.equal(finished.status, "error");
  assert.equal(finished.resumable, true);
  assert.equal(finished.partialText, "export async function worker() {\n  const queue = [];");
  assert.equal(store.activeCount, 0);
  assert.equal(store.historyCount, 1);

  // Filter list
  const resumable = store.list({ status: "resumable" });
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0].id, "run_test_001");

  // Resume task
  const resumed = store.markResumed("run_test_001");
  assert.ok(resumed);
  assert.equal(resumed.resumable, false);
  assert.equal(resumed.resumeCount, 1);
  assert.equal(resumed.status, "thinking");
  assert.equal(store.activeCount, 1);
  assert.equal(store.historyCount, 0);

  // Final successful finish
  const completed = store.finish("run_test_001", {
    status: "done",
    text: "export async function worker() {\n  const queue = [];\n  return queue;\n}",
  });
  assert.equal(completed.status, "done");
  assert.equal(completed.resumable, false);
  assert.equal(store.activeCount, 0);
  assert.equal(store.historyCount, 1);
});

test("melon CLI parses tasks, resume, and abort commands correctly", () => {
  const p1 = parseCliArgs(["tasks", "resumable"]);
  assert.equal(p1.command, "tasks");
  assert.equal(p1.filter, "resumable");

  const p2 = parseCliArgs(["ps"]);
  assert.equal(p2.command, "tasks");
  assert.equal(p2.filter, "all");

  const p3 = parseCliArgs(["resume", "run_12345", "Continue with the tests"]);
  assert.equal(p3.command, "resume");
  assert.equal(p3.taskId, "run_12345");
  assert.equal(p3.prompt, "Continue with the tests");

  const p4 = parseCliArgs(["abort", "run_67890"]);
  assert.equal(p4.command, "abort");
  assert.equal(p4.taskId, "run_67890");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createThreadStore } from "../server/threads.mjs";

test("thread store keeps user/assistant turns and status", () => {
  let tick = 1;
  const store = createThreadStore({ now: () => tick++, maxThreads: 2, maxMessages: 3 });
  const thread = store.create({ id: "t1", title: "OAuth review" });
  assert.equal(thread.id, "t1");
  assert.equal(thread.status, "idle");

  store.append("t1", { role: "user", text: "please review", runId: "r1" });
  store.append("t1", { role: "assistant", text: "looks good", runId: "r1", taint: "untrusted" });
  store.setStatus("t1", "streaming");

  const loaded = store.get("t1");
  assert.equal(loaded.status, "streaming");
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, "user");
  assert.equal(loaded.messages[1].taint, "untrusted");
  assert.deepEqual(loaded.runIds, ["r1"]);

  store.append("t1", { role: "system", text: "note" });
  store.append("t1", { role: "system", text: "drop me" });
  assert.equal(store.get("t1").messages.length, 3);

  assert.equal(store.ensure("t1", { title: "ignored" }).title, "OAuth review");
  const second = store.ensure("t2", { title: "New" });
  assert.equal(second.title, "New");
  store.create({ id: "t3", title: "Oldest" });
  assert.equal(store.list().length, 2);
  assert.equal(store.get("t1"), null);
  assert.equal(store.remove("t3"), true);
  assert.equal(store.get("t3"), null);
});

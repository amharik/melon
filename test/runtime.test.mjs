import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MelonCore } from "../web/shared/wasm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const bytes = await fs.readFile(path.join(ROOT, "web/wasm/melon_core.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new MelonCore(instance.exports);
}

const graph = {
  nodes: [
    { id: "src", kind: "source", trigger: "all", inputs: [], outputs: ["out"] },
    { id: "sink", kind: "sink", trigger: "any", inputs: ["in"], outputs: [] },
  ],
  edges: [{ id: "e1", from: { node: "src", port: "out" }, to: { node: "sink", port: "in" } }],
};

test("wasm ABI answers ping", async () => {
  const core = await loadCore();
  const out = core.ping();
  assert.equal(out.ok, true);
  assert.equal(out.version, "0.1.0");
  assert.equal(core.exports.melon_version(), 1);
});

test("wasm core schedules a routed job", async () => {
  const core = await loadCore();
  const set = core.call({ op: "set_graph", graph });
  assert.equal(set.ok, true);

  const emitted = core.call({
    op: "emit",
    node: "src",
    port: "out",
    message: { type: "text", text: "hello" },
  });
  assert.equal(emitted.ok, true);
  assert.equal(emitted.commands.length, 1);
  const command = emitted.commands[0];
  assert.equal(command.node, "sink");
  assert.equal(command.inputs.in[0].text, "hello");

  const finished = core.call({ op: "finish", job: command.job });
  assert.equal(finished.ok, true);
  assert.equal(finished.events.filter((e) => e.type === "job.finished").length, 1);
});

test("wasm core rejects invalid graphs atomically", async () => {
  const core = await loadCore();
  const out = core.call({
    op: "set_graph",
    graph: {
      nodes: [{ id: "a", kind: "task", inputs: ["in"], outputs: ["out"] }],
      edges: [{ id: "e1", from: { node: "a", port: "missing" }, to: { node: "a", port: "in" } }],
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /no output port/);
  assert.equal(core.ping().version, "0.1.0");
});

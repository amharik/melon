import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_ADAPTERS,
  extractJsonObject,
  validatePlanGraph,
} from "../web/shared/planner.js";
import { MelonCore } from "../web/shared/wasm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const valid = {
  nodes: [
    { id: "Brief", kind: "source", label: "Brief", config: { topic: "Review the release" } },
    { id: "claude", kind: "agent", label: "Claude", config: { adapter: "claude" } },
    { id: "gemini", kind: "agent", label: "Gemini", config: { adapter: "demo:gemini" } },
    {
      id: "moderator",
      kind: "agent",
      label: "Moderator",
      inputs: ["rev1", "rev2"],
      config: { adapter: "moderator", instructions: "Synthesize both reviews." }
    },
    { id: "Decision", kind: "sink", label: "Decision" },
  ],
  edges: [
    { id: "e1", from: { node: "Brief", port: "out" }, to: { node: "claude", port: "in" } },
    { id: "e2", from: { node: "Brief", port: "out" }, to: { node: "gemini", port: "in" } },
    { id: "e3", from: { node: "claude", port: "result" }, to: { node: "moderator", port: "rev1" } },
    { id: "e4", from: { node: "gemini", port: "result" }, to: { node: "moderator", port: "rev2" } },
    { id: "e5", from: { node: "moderator", port: "result" }, to: { node: "Decision", port: "in" } },
  ],
};

test("planner accepts a valid graph and normalizes ids, adapters, and layout", () => {
  const result = validatePlanGraph(valid, { goal: "fallback goal" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.graph.nodes.length, 5);
  assert.equal(result.graph.edges.length, 5);
  assert.equal(result.graph.nodes[0].id, "brief");
  assert.equal(result.graph.nodes[0].config.topic, "Review the release");
  assert.equal(result.graph.nodes[1].config.adapter, "demo:claude");
  assert.equal(result.graph.nodes[2].config.adapter, "demo:gemini");
  assert.equal(result.graph.nodes[3].config.adapter, "demo:moderator");
  assert.equal(result.graph.nodes[3].config.instructions, "Synthesize both reviews.");
  assert.deepEqual(result.graph.nodes[3].inputs, ["rev1", "rev2"]);
  assert.equal(result.graph.nodes[3].trigger, "all");
  assert.ok(result.graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.deepEqual(
    result.graph.nodes.map((node) => node.kind),
    ["source", "agent", "agent", "agent", "sink"]
  );
});

test("planner infers moderator inputs from custom edge ports", () => {
  const result = validatePlanGraph({
    nodes: [
      { id: "brief", kind: "source" },
      { id: "reviewer-a", kind: "agent", config: { adapter: "claude" } },
      { id: "reviewer-b", kind: "agent", config: { adapter: "gemini" } },
      { id: "moderator", kind: "agent", config: { adapter: "moderator" } },
      { id: "decision", kind: "sink" },
    ],
    edges: [
      { from: { node: "brief", port: "out" }, to: { node: "reviewer-a", port: "in" } },
      { from: { node: "brief", port: "out" }, to: { node: "reviewer-b", port: "in" } },
      { from: { node: "reviewer-a", port: "result" }, to: { node: "moderator", port: "rev1" } },
      { from: { node: "reviewer-b", port: "result" }, to: { node: "moderator", port: "rev2" } },
      { from: { node: "moderator", port: "result" }, to: { node: "decision", port: "in" } },
    ],
  });
  assert.equal(result.ok, true);
  const moderator = result.graph.nodes.find((node) => node.id === "moderator");
  assert.deepEqual(moderator.inputs, ["rev1", "rev2"]);
  assert.equal(moderator.trigger, "all");
});

test("planner uses the goal as the source topic when absent", () => {
  const result = validatePlanGraph(
    {
      nodes: [
        { id: "brief", kind: "source" },
        { id: "claude", kind: "agent", config: { adapter: "claude" } },
        { id: "decision", kind: "sink" },
      ],
      edges: [
        { from: { node: "brief", port: "out" }, to: { node: "claude", port: "in" } },
        { from: { node: "claude", port: "result" }, to: { node: "decision", port: "in" } },
      ],
    },
    { goal: "Plan a launch review" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.graph.nodes[0].config.topic, "Plan a launch review");
});

test("planner rejects cycles, unknown adapters, and unreachable nodes", () => {
  const cyclic = validatePlanGraph({
    nodes: [
      { id: "brief", kind: "source" },
      { id: "one", kind: "agent", config: { adapter: "claude" } },
      { id: "two", kind: "agent", config: { adapter: "gemini" } },
      { id: "decision", kind: "sink" },
    ],
    edges: [
      { from: { node: "brief", port: "out" }, to: { node: "one", port: "in" } },
      { from: { node: "one", port: "result" }, to: { node: "two", port: "in" } },
      { from: { node: "two", port: "result" }, to: { node: "one", port: "in" } },
      { from: { node: "two", port: "result" }, to: { node: "decision", port: "in" } },
    ],
  });
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some((error) => /cycle/.test(error)));

  const badAdapter = validatePlanGraph({
    nodes: [
      { id: "brief", kind: "source" },
      { id: "agent", kind: "agent", config: { adapter: "unknown" } },
      { id: "decision", kind: "sink" },
    ],
    edges: [
      { from: { node: "brief", port: "out" }, to: { node: "agent", port: "in" } },
      { from: { node: "agent", port: "result" }, to: { node: "decision", port: "in" } },
    ],
  });
  assert.equal(badAdapter.ok, false);
  assert.ok(badAdapter.errors.some((error) => /unsupported adapter/.test(error)));

  const unreachable = validatePlanGraph({
    nodes: [
      { id: "brief", kind: "source" },
      { id: "claude", kind: "agent", config: { adapter: "claude" } },
      { id: "gemini", kind: "agent", config: { adapter: "gemini" } },
      { id: "decision", kind: "sink" },
    ],
    edges: [
      { from: { node: "brief", port: "out" }, to: { node: "claude", port: "in" } },
      { from: { node: "claude", port: "result" }, to: { node: "decision", port: "in" } },
    ],
  });
  assert.equal(unreachable.ok, false);
  assert.ok(unreachable.errors.some((error) => /not reachable/.test(error)));
});

test("planner extracts fenced JSON and reports missing structure", () => {
  const parsed = extractJsonObject("Here you go:\n```json\n{\"nodes\":[],\"edges\":[]}\n```");
  assert.deepEqual(parsed, { nodes: [], edges: [] });
  assert.throws(() => extractJsonObject("no object"), /JSON object/);

  const empty = validatePlanGraph({ nodes: [], edges: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((error) => /at least a source/.test(error)));
});

test("planner adapters stay in sync with the canvas vocabulary", () => {
  assert.deepEqual(PLAN_ADAPTERS, [
    "demo:claude",
    "demo:gemini",
    "demo:mistral",
    "demo:chatgpt",
    "demo:moderator",
    "ext",
    "opencode",
    "llm",
  ]);
});

test("canvas exposes a review-and-apply planner flow", async () => {
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");
  for (const id of ["btn-plan", "plan-block", "plan-json", "btn-plan-apply", "btn-plan-discard"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /fetch\("\/api\/plan"/);
  assert.match(app, /planProposal = data\.graph/);
  assert.match(app, /function applyPlan/);
  assert.match(app, /markPlanStale/);
  assert.match(app, /candidates: hub\.kev \? 3 : 1/);
  assert.match(app, /\/api\/kev\/rerank/);
  assert.match(app, /function rerankInputs/);
  assert.match(app, /f-retrieve-context/);
});

test("validated planner graphs are accepted by the wasm core", async () => {
  const result = validatePlanGraph(valid, { goal: "core compatibility" });
  assert.equal(result.ok, true);
  const bytes = await fs.readFile(path.join(ROOT, "web/wasm/melon_core.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = new MelonCore(instance.exports);
  const set = core.call({
    op: "set_graph",
    graph: {
      nodes: result.graph.nodes,
      edges: result.graph.edges,
      options: { maxQueue: 2048 },
    },
  });
  assert.equal(set.ok, true);
  assert.equal(Object.keys(set.metrics.nodes).length, 5);
});

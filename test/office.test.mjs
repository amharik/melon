import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MelonCore } from "../web/shared/wasm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("office view exposes DOM elements, modals, and actions", async () => {
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const requiredIds = [
    "btn-office-view",
    "office-view",
    "btn-office-hire",
    "btn-office-sync",
    "office-war-seats",
    "office-decision-preview",
    "office-desks",
    "modal-hire",
    "modal-tap",
    "form-hire-agent",
    "form-tap-agent",
    "hire-label",
    "hire-id",
    "hire-adapter",
    "tap-target-node-id",
    "tap-sender",
    "tap-message",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected DOM id "${id}" in web/index.html`);
  }
});

test("office view implements dynamic roster, war-room sync, and peer delegation", async () => {
  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");

  assert.match(app, /function renderOfficeView/);
  assert.match(app, /function renderWarRoomSeats/);
  assert.match(app, /function renderWarRoomDecision/);
  assert.match(app, /function renderOfficeDesks/);
  assert.match(app, /function createDeskCard/);
  assert.match(app, /function updateOfficeDesk/);
  assert.match(app, /function syncWarRoomDecision/);

  // Dynamic add / remove
  assert.match(app, /function hireAgent/);
  assert.match(app, /function dismissAgent/);

  // Named ID peer delegation
  assert.match(app, /function openTapModal/);
  assert.match(app, /function triggerPeerTurn/);
  assert.match(app, /function detectPeerDelegation/);

  // Turn bounding: max 3 hops
  assert.match(app, /hops\s*>=\s*3/);
});

test("peer delegation extracts @mentions and bounds hops", () => {
  const text = "Thanks for the initial review! I would like @gemini to audit the authentication edge cases.";
  const matches = [...text.matchAll(/@([a-zA-Z0-9_-]{2,24})/g)];
  assert.equal(matches.length, 1);
  assert.equal(matches[0][1], "gemini");

  const multiText = "Checking in with @claude and @auditor-qa on performance.";
  const multiMatches = [...multiText.matchAll(/@([a-zA-Z0-9_-]{2,24})/g)].map((m) => m[1]);
  assert.deepEqual(multiMatches, ["claude", "auditor-qa"]);
});

test("dynamically hired and dismissed agent graphs are accepted atomically by wasm core", async () => {
  const bytes = await fs.readFile(path.join(ROOT, "web/wasm/melon_core.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = new MelonCore(instance.exports);

  // Base graph
  const baseGraph = {
    nodes: [
      { id: "src", kind: "source", trigger: "all", inputs: [], outputs: ["out"] },
      { id: "sink", kind: "sink", trigger: "any", inputs: ["in"], outputs: [] },
    ],
    edges: [{ id: "e1", from: { node: "src", port: "out" }, to: { node: "sink", port: "in" } }],
  };

  const set1 = core.call({ op: "set_graph", graph: baseGraph });
  assert.equal(set1.ok, true);

  // Dynamically "hire" a security agent
  const hiredGraph = {
    nodes: [
      { id: "src", kind: "source", trigger: "all", inputs: [], outputs: ["out"] },
      { id: "agent-sec", kind: "agent", trigger: "all", inputs: ["in"], outputs: ["result"] },
      { id: "sink", kind: "sink", trigger: "any", inputs: ["in"], outputs: [] },
    ],
    edges: [
      { id: "e1", from: { node: "src", port: "out" }, to: { node: "agent-sec", port: "in" } },
      { id: "e2", from: { node: "agent-sec", port: "result" }, to: { node: "sink", port: "in" } },
    ],
  };

  const set2 = core.call({ op: "set_graph", graph: hiredGraph });
  assert.equal(set2.ok, true);
  assert.equal(Object.keys(set2.metrics.nodes).length, 3);

  // Dynamically "dismiss" the agent
  const dismissedGraph = {
    nodes: [
      { id: "src", kind: "source", trigger: "all", inputs: [], outputs: ["out"] },
      { id: "sink", kind: "sink", trigger: "any", inputs: ["in"], outputs: [] },
    ],
    edges: [{ id: "e3", from: { node: "src", port: "out" }, to: { node: "sink", port: "in" } }],
  };

  const set3 = core.call({ op: "set_graph", graph: dismissedGraph });
  assert.equal(set3.ok, true);
  assert.equal(Object.keys(set3.metrics.nodes).length, 2);
});

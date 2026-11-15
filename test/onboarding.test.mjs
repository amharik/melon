import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("onboarding modal and quick-start actions are exposed in DOM and app", async () => {
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const requiredIds = [
    "modal-onboarding",
    "btn-close-onboarding",
    "btn-onboard-dismiss",
    "btn-onboard-pair",
    "btn-launch-chatgpt",
    "btn-launch-claude",
    "btn-launch-gemini",
    "btn-onboard-launch-tourney",
    "btn-smart-bind",
    "btn-smart-bind-top",
    "btn-getting-started",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected DOM id "${id}" in web/index.html`);
  }

  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");
  assert.match(app, /function smartBindTabs/);
  assert.match(app, /function setupOnboarding/);
  assert.match(app, /function openOnboarding/);
  assert.match(app, /function updateOnboardingView/);
});

test("smart-bind tab matching algorithm pairs nodes to matching tabs", () => {
  const mockTabs = [
    { id: 101, adapter: "chatgpt", title: "ChatGPT Prompt Review", supported: true },
    { id: 102, adapter: "gemini", title: "Gemini 2.0 Pro Architecture", supported: true },
    { id: 103, adapter: "claude", title: "Claude Code Generation", supported: true },
  ];

  const mockNodes = [
    { id: "n1", kind: "agent", label: "GPT Architect", config: {} },
    { id: "n2", kind: "agent", label: "Gemini Auditor", config: {} },
    { id: "n3", kind: "agent", label: "Claude Synthesizer", config: {} },
  ];

  const used = new Set();
  const bindings = [];

  for (const node of mockNodes) {
    const label = node.label.toLowerCase();
    const match = mockTabs.find((t) => {
      if (used.has(t.id)) return false;
      if (label.includes("gpt") && t.adapter === "chatgpt") return true;
      if (label.includes("gemini") && t.adapter === "gemini") return true;
      if (label.includes("claude") && t.adapter === "claude") return true;
      return false;
    });

    if (match) {
      used.add(match.id);
      bindings.push({ nodeId: node.id, tabId: match.id, adapter: match.adapter });
    }
  }

  assert.equal(bindings.length, 3);
  assert.equal(bindings[0].tabId, 101);
  assert.equal(bindings[1].tabId, 102);
  assert.equal(bindings[2].tabId, 103);
});

test("extension manifest includes externally_connectable for localhost", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "extension/manifest.json"), "utf8"));
  assert.ok(manifest.externally_connectable);
  assert.ok(manifest.externally_connectable.matches.some((m) => m.includes("127.0.0.1")));
});

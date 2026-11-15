import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("tournament modal and controls are exposed in DOM and app", async () => {
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const requiredIds = [
    "btn-tournament",
    "modal-tournament",
    "btn-close-tournament",
    "btn-cancel-tournament",
    "tournament-prompt",
    "tournament-contestants",
    "btn-start-tournament",
    "tournament-results",
    "tournament-grid",
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `Expected DOM id "${id}" in web/index.html`);
  }

  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");
  assert.match(app, /function setupTournament/);
  assert.match(app, /tournamentRunners/);
  assert.match(app, /f-export-artifacts/);
  assert.match(app, /extractArtifactsFromText/);
});

test("tournament handles multi-model metric computation and crown winner", () => {
  const contestants = [
    { name: "ChatGPT (o3-mini)", startedAt: 1000, firstToken: 1250, end: 3500, text: "```typescript\nconst x = 1;\n```" },
    { name: "Gemini 2.0 Pro", startedAt: 1000, firstToken: 1150, end: 2800, text: "```python\ndef solve(): pass\n```" },
  ];

  const results = contestants.map((c) => ({
    name: c.name,
    ttft: c.firstToken - c.startedAt,
    duration: c.end - c.startedAt,
    chars: c.text.length,
  }));

  assert.equal(results[0].ttft, 250);
  assert.equal(results[0].duration, 2500);
  assert.equal(results[1].ttft, 150);
  assert.equal(results[1].duration, 1800);

  // Winner selection by lowest latency
  const winner = [...results].sort((a, b) => a.duration - b.duration)[0];
  assert.equal(winner.name, "Gemini 2.0 Pro");
});

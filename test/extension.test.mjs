import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");

test("extension manifest references real files", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(EXT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);

  const files = [
    manifest.background.service_worker,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((script) => script.js),
  ];
  for (const file of files) {
    const stat = await fs.stat(path.join(EXT, file));
    assert.equal(stat.isFile(), true, `${file} should exist`);
  }

  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.host_permissions.some((host) => host.includes("claude.ai")));
  assert.ok(manifest.host_permissions.some((host) => host.includes("127.0.0.1")));
});

test("extension uses the documented bridge messages", async () => {
  const background = await fs.readFile(path.join(EXT, "background.js"), "utf8");
  const content = await fs.readFile(path.join(EXT, "content.js"), "utf8");
  const adapters = await fs.readFile(path.join(EXT, "adapters.js"), "utf8");
  for (const message of ["agent.run", "run.event", "cancel", "tabs"]) {
    assert.match(background, new RegExp(message.replace(".", "\\.")));
  }
  for (const message of ["melon.ping", "melon.run", "melon.cancel", "melon.kev.rerank"]) {
    assert.match(content, new RegExp(message.replace(".", "\\.")));
  }
  assert.match(content, /retrievePageContext/);
  assert.match(content, /Untrusted page context/);
  assert.match(adapters, /rankCandidates/);
  assert.match(background, /tabHealth/);
  assert.match(background, /HEALTH_TIMEOUT/);
  assert.match(background, /sendToTab\(tab\.id, \{ type: "melon\.ping" \}\)/);
  assert.match(background, /importScripts\("adapters\.js"\)/);
  assert.match(background, /CONSENT_VERSION/);
  assert.match(background, /controlId/);
  assert.match(content, /showControlBadge/);
  assert.match(content, /melon-control/);

  const app = await fs.readFile(path.join(ROOT, "web", "app.js"), "utf8");
  assert.match(app, /tabHealthInfo/);
  assert.match(app, /send missing · Enter fallback/);
  assert.match(app, /controlId/);
  assert.match(app, /inputsTainted/);
  assert.match(app, /node-taint/);
  assert.match(app, /Some upstream content is untrusted browser-tab text/);

  const options = await fs.readFile(path.join(EXT, "options.html"), "utf8");
  assert.match(options, /id="consent"/);
  for (const site of ["chatgpt", "claude", "gemini", "mistral"]) {
    assert.match(adapters, new RegExp(site));
  }
});

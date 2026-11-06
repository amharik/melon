import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  inputsTainted,
  isTainted,
  promptFromInputs,
} from "../web/shared/protocol.js";

test("taint helpers detect browser-tab messages", () => {
  assert.equal(isTainted({ text: "hi" }), false);
  assert.equal(isTainted({ text: "hi", taint: "untrusted" }), true);
  assert.equal(inputsTainted({}), false);
  assert.equal(inputsTainted({ in: { text: "clean" } }), false);
  assert.equal(inputsTainted({ in: [{ text: "clean" }, { text: "tab", taint: "untrusted" }] }), true);
});

test("promptFromInputs labels tainted ports and leaves clean content alone", () => {
  const clean = promptFromInputs({ in: { text: "clean review" } });
  assert.equal(clean, "clean review");

  const tainted = promptFromInputs({
    rev1: [{ type: "text", text: "tab output", taint: "untrusted" }],
  });
  assert.match(tainted, /rev1\n\[UNTRUSTED BROWSER CONTENT/);
  assert.match(tainted, /tab output$/);
});

test("promptFromInputs labels tainted context when no input triggered the node", () => {
  const prompt = promptFromInputs({}, { ctx: { text: "page text", taint: "untrusted" } });
  assert.match(prompt, /ctx\n\[UNTRUSTED BROWSER CONTENT/);
  assert.match(prompt, /page text$/);
});

test("canvas marks extension output and downstream lineage as untrusted", async () => {
  const source = await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /inputsTainted/);
  assert.match(source, /adapter === "ext"/);
  assert.match(source, /untrusted browser-tab text/);
  assert.match(source, /command\.__record\.taint = taint/);
});

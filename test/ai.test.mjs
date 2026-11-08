import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");

async function modelCatalog() {
  const source = await fs.readFile(path.join(EXT, "ai", "models.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "models.js" });
  return context.MELON_AI;
}

test("local AI model catalog includes Qwen and equivalent models", async () => {
  const catalog = await modelCatalog();
  assert.ok(Array.isArray(catalog.MODELS));
  assert.ok(catalog.MODELS.length >= 4);
  assert.ok(catalog.byId[catalog.DEFAULT_MODEL_ID]);

  const ids = new Set();
  for (const model of catalog.MODELS) {
    assert.ok(!ids.has(model.id), `duplicate model id ${model.id}`);
    ids.add(model.id);
    assert.ok(model.label);
    assert.match(model.model, /^[\w.-]+\/[\w.-]+$/);
    assert.match(model.revision, /^[0-9a-f]{40}$/);
    assert.ok(["q4f16", "q4"].includes(model.dtype));
    assert.ok(model.approxBytes > 0);
    assert.ok(model.license);
  }

  assert.ok(catalog.MODELS.some((model) => model.model.includes("Qwen2.5-1.5B")));
  assert.ok(catalog.MODELS.some((model) => model.model.includes("Llama-3.2")));
  assert.ok(catalog.MODELS.some((model) => model.model.includes("LFM2.5")));
  assert.ok(catalog.HF_ORIGINS.includes("https://huggingface.co/*"));
});

test("extension exposes an optional offscreen AI model picker", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(EXT, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.optional_host_permissions.includes("https://huggingface.co/*"));
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.match(manifest.content_security_policy.extension_pages, /127\.0\.0\.1/);
  assert.match(manifest.content_security_policy.extension_pages, /worker-src 'self'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /worker-src[^;]*blob:/);

  const options = await fs.readFile(path.join(EXT, "options.html"), "utf8");
  for (const id of ["ai-enabled", "ai-model", "ai-download", "ai-test", "ai-unload", "ai-progress", "consent"]) {
    assert.match(options, new RegExp(`id="${id}"`));
  }
  assert.match(options, /ai\/models\.js/);

  const offscreen = await fs.readFile(path.join(EXT, "ai", "offscreen.html"), "utf8");
  assert.match(offscreen, /offscreen\.js/);
  assert.match(offscreen, /models\.js/);
});

test("background routes model selection, download, and unload", async () => {
  const background = await fs.readFile(path.join(EXT, "background.js"), "utf8");
  for (const message of [
    "melon.ai.status",
    "melon.ai.select",
    "melon.ai.enable",
    "melon.ai.prepare",
    "melon.ai.unload",
    "melon.ai.test",
  ]) {
    assert.match(background, new RegExp(message.replaceAll(".", "\\.")));
  }
  assert.match(background, /importScripts\("ai\/models\.js", "ai\/planner\.js"\)/);
  assert.match(background, /agent\.plan/);
  assert.match(background, /plan\.result/);
  assert.match(background, /melon\.kev\.rerank/);
  assert.match(background, /retrievePageContext/);
  assert.match(background, /createDocument/);
  assert.match(background, /HF_ORIGINS/);
});

test("offscreen model host downloads with WebGPU and reports progress", async () => {
  const host = await fs.readFile(path.join(EXT, "ai", "offscreen.js"), "utf8");
  assert.match(host, /from "\.\.\/vendor\/transformers\.min\.js"/);
  assert.match(host, /pipeline\("text-generation"/);
  assert.match(host, /device: runtime\.device/);
  assert.match(host, /progress_callback/);
  assert.match(host, /requestAdapter/);
  assert.match(host, /wasmPaths/);
  assert.match(host, /revision:/);
  assert.match(host, /model\.device === "wasm"/);
});

test("local planner prompt requires one validated JSON graph", async () => {
  const source = await fs.readFile(path.join(EXT, "ai", "planner.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "planner.js" });
  const planner = context.MELON_PLANNER;
  assert.ok(planner.ALLOWED_ADAPTERS.includes("demo:moderator"));
  assert.ok(planner.ALLOWED_ADAPTERS.includes("ext"));
  assert.match(planner.SYSTEM_PROMPT, /ONLY one JSON object/);
  assert.match(planner.SYSTEM_PROMPT, /No cycles/);
  assert.match(planner.SYSTEM_PROMPT, /[Ee]xactly one source/);
  assert.match(planner.SYSTEM_PROMPT, /Reviewers are "agent" nodes/);
  assert.match(planner.SYSTEM_PROMPT, /Never invent an adapter/);
  assert.match(planner.SYSTEM_PROMPT, /Valid two-reviewer example/);
  const messages = planner.messagesForGoal("review the launch");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content, "review the launch");
  assert.ok(planner.VARIANTS.length >= 4);
  const alternate = planner.messagesForGoal("review the launch", 2);
  assert.match(alternate[1].content, /Planning preference:/);
  assert.notEqual(alternate[1].content, messages[1].content);
  assert.throws(() => planner.messagesForGoal("   "), /goal is required/);
});

test("vendor script pins the local AI runtime versions", async () => {
  const script = await fs.readFile(path.join(ROOT, "scripts", "vendor-ai.sh"), "utf8");
  assert.match(script, /@huggingface\/transformers@\$\{TRANSFORMERS_VERSION\}/);
  assert.match(script, /onnxruntime-web@\$\{ORT_VERSION\}/);
  assert.match(script, /transformers\.min\.js/);
  assert.match(script, /ort-wasm-simd-threaded\.asyncify\.wasm/);
  assert.match(script, /ort\.webgpu\.bundle\.min\.mjs/);
});

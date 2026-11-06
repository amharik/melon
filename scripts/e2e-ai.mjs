#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODEL = process.env.MELON_E2E_AI_MODEL
  ? JSON.parse(process.env.MELON_E2E_AI_MODEL)
  : {
      id: "e2e-tiny-llama",
      model: "onnx-community/tiny-random-LlamaForCausalLM-ONNX",
      revision: "main",
      dtype: "q4f16",
      dtypeFallback: "q4",
    };
const GENERATE = process.env.MELON_E2E_AI_GENERATE === "1";
const PROMPT =
  process.env.MELON_E2E_AI_PROMPT ||
  'Reply with exactly this JSON and nothing else: {"ok":true}';
const MAX_NEW_TOKENS = Math.max(
  1,
  Math.min(256, Number(process.env.MELON_E2E_AI_MAX_NEW_TOKENS) || 24)
);

function log(message) {
  console.log(`[e2e:ai] ${message}`);
}

function extensionIdForPath(dir) {
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    const entries = await fs.readdir(cache);
    const versions = entries
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const version of versions) {
      candidates.push(path.join(cache, version, "chrome-linux64", "chrome"));
      candidates.push(path.join(cache, version, "chrome-linux", "chrome"));
    }
  } catch {}
  candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Chromium not found. Set CHROME_PATH or install Chrome/Chromium.");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, label, timeout = 20000, interval = 100) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

class CDP {
  static async connect(url) {
    const cdp = new CDP(url);
    await cdp.opened;
    return cdp;
  }

  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed";
      throw new Error(text);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function browserWs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  const data = await response.json();
  return data.webSocketDebuggerUrl;
}

async function prepareExtension(tmp) {
  const target = path.join(tmp, "extension");
  await fs.cp(EXT, target, { recursive: true });
  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const origin of manifest.optional_host_permissions || []) {
    if (!manifest.host_permissions.includes(origin)) manifest.host_permissions.push(origin);
  }
  delete manifest.optional_host_permissions;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

async function main() {
  const chromePath = await findChrome();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "melon-e2e-ai-"));
  const extension = await prepareExtension(tmp);
  const extensionId = extensionIdForPath(await fs.realpath(extension));
  const profile = path.join(tmp, "profile");
  const debugPort = await freePort();
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-quic",
      "--password-store=basic",
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );
  let chromeLogs = "";
  chrome.stdout.on("data", (data) => (chromeLogs += data));
  chrome.stderr.on("data", (data) => (chromeLogs += data));
  chrome.stdout.on("error", () => {});
  chrome.stderr.on("error", () => {});
  chrome.on("error", (err) => (chromeLogs += `spawn error: ${err.message}\n`));
  chrome.on("exit", (code, signal) => (chromeLogs += `chrome exited: ${code} ${signal}\n`));

  let browserCdp = null;
  let optionsCdp = null;
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return response?.ok;
    }, "Chromium DevTools", 30000);
    log(`Chromium ${chromePath}`);

    const worker = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find(
        (target) =>
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js`
      );
    }, "extension service worker");
    log(`extension worker ${worker.url}`);

    browserCdp = await CDP.connect(await browserWs(debugPort));
    const optionsTarget = await browserCdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/options.html`,
    });
    const optionsPage = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find((target) => target.id === optionsTarget.targetId);
    }, "extension options page");
    optionsCdp = await CDP.connect(optionsPage.webSocketDebuggerUrl);
    await optionsCdp.send("Runtime.enable");

    const options = await optionsCdp.evaluate(`({
      secure: isSecureContext,
      gpu: !!navigator.gpu,
      storage: !!chrome.storage?.local,
      offscreen: !!chrome.offscreen,
    })`);
    if (!options.secure || !options.gpu || !options.storage || !options.offscreen) {
      throw new Error(`options context is missing capabilities: ${JSON.stringify(options)}`);
    }
    log("options context is secure with WebGPU and offscreen support");

    await optionsCdp.evaluate(
      `chrome.offscreen.createDocument({
        url: "ai/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Melon local AI E2E",
      })`
    );
    const offscreenTarget = await waitFor(async () => {
      const list = await targets(debugPort);
      return list.find((target) => target.url === `chrome-extension://${extensionId}/ai/offscreen.html`);
    }, "offscreen document");
    const offscreenCdp = await CDP.connect(offscreenTarget.webSocketDebuggerUrl);
    await offscreenCdp.send("Runtime.enable");
    const offscreen = await offscreenCdp.evaluate(`({ secure: isSecureContext, gpu: !!navigator.gpu })`);
    if (!offscreen.secure || !offscreen.gpu) {
      throw new Error(`offscreen context is missing WebGPU: ${JSON.stringify(offscreen)}`);
    }
    offscreenCdp.close();
    log("offscreen context is secure with WebGPU");

    log(`loading ${MODEL.id} (${MODEL.model})`);
    await optionsCdp.evaluate(
      `chrome.runtime.sendMessage({
        target: "melon-ai",
        type: "ai.prepare",
        model: ${JSON.stringify(MODEL)},
      })`
    );

    const state = await waitFor(
      async () => {
        const current = await optionsCdp.evaluate(
          `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.status" })`
        );
        if (current?.state?.status === "error") {
          throw new Error(current.state.error || "model load failed");
        }
        return current?.state?.status === "ready" ? current.state : null;
      },
      "local model load",
      180000,
      500
    );
    if (!state.device?.startsWith("webgpu")) {
      throw new Error(`model did not use WebGPU: ${state.device}`);
    }
    log(`local model ready on ${state.device}`);

    if (GENERATE) {
      log(`generating up to ${MAX_NEW_TOKENS} tokens`);
      const reply = await optionsCdp.evaluate(
        `chrome.runtime.sendMessage({
          target: "melon-ai",
          type: "ai.generate",
          messages: [{ role: "user", content: ${JSON.stringify(PROMPT)} }],
          maxNewTokens: ${MAX_NEW_TOKENS},
        })`
      );
      if (!reply?.ok) throw new Error(reply?.error || "local generation failed");
      log(`generated ${String(reply.text || "").length} chars: ${String(reply.text || "").slice(0, 120)}`);
    }

    await optionsCdp.evaluate(
      `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.unload" })`
    );
    await waitFor(
      async () => {
        const current = await optionsCdp.evaluate(
          `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.status" })`
        );
        return current?.state?.status === "idle";
      },
      "model unload",
      10000,
      200
    );
    log("PASS");
  } catch (err) {
    console.error(`[e2e:ai] FAIL: ${err.stack || err}`);
    if (chromeLogs.trim()) console.error(`\n[chromium]\n${chromeLogs.trim().slice(-4000)}`);
    process.exitCode = 1;
  } finally {
    optionsCdp?.close();
    browserCdp?.close();
    try {
      process.kill(-chrome.pid, "SIGTERM");
    } catch {
      chrome.kill("SIGTERM");
    }
    await sleep(500);
    try {
      process.kill(-chrome.pid, "SIGKILL");
    } catch {}
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main();

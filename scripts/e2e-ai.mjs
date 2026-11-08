#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { extractJsonObject, validatePlanGraph } from "../web/shared/planner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extension");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEVICE = process.env.MELON_E2E_AI_DEVICE || "";
const MODEL = process.env.MELON_E2E_AI_MODEL
  ? JSON.parse(process.env.MELON_E2E_AI_MODEL)
  : {
      id: "e2e-tiny-llama",
      model: "onnx-community/tiny-random-LlamaForCausalLM-ONNX",
      revision: "main",
      dtype: "q4f16",
      dtypeFallback: "q4",
    };
if (DEVICE) MODEL.device = DEVICE;
const GENERATE = process.env.MELON_E2E_AI_GENERATE === "1";
const HARDWARE = process.env.MELON_E2E_AI_HARDWARE === "1";
const HEADLESS =
  process.env.MELON_E2E_AI_HEADLESS === "1"
    ? true
    : process.env.MELON_E2E_AI_HEADLESS === "0"
      ? false
      : !HARDWARE;
const PLANNER = process.env.MELON_E2E_AI_PLANNER === "1";
const GOAL =
  process.env.MELON_E2E_AI_GOAL ||
  "Review a product launch plan with two independent reviewers and synthesize a decision.";
const PLANNER_ATTEMPTS = Math.max(
  1,
  Math.min(4, Number(process.env.MELON_E2E_AI_PLANNER_ATTEMPTS) || 2)
);
const PROMPT =
  process.env.MELON_E2E_AI_PROMPT ||
  'Reply with exactly this JSON and nothing else: {"ok":true}';
const MAX_NEW_TOKENS = Math.max(
  1,
  Math.min(256, Number(process.env.MELON_E2E_AI_MAX_NEW_TOKENS) || 24)
);
const PLANNER_MAX_NEW_TOKENS = Math.max(
  1,
  Math.min(1200, Number(process.env.MELON_E2E_AI_PLANNER_MAX_NEW_TOKENS) || 900)
);
const LOAD_TIMEOUT = Math.max(
  60000,
  Number(process.env.MELON_E2E_AI_LOAD_TIMEOUT) || (HARDWARE || PLANNER ? 600000 : 180000)
);
const GENERATE_TIMEOUT = Math.max(
  20000,
  Number(process.env.MELON_E2E_AI_GENERATE_TIMEOUT) || (HARDWARE || PLANNER ? 600000 : 120000)
);
const PROFILE = process.env.MELON_E2E_AI_PROFILE || null;

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
      candidates.push(path.join(cache, version, "chrome-linux-arm64", "chrome"));
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

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 20000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs
    );
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
  if (HARDWARE && !HEADLESS && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("MELON_E2E_AI_HARDWARE=1 needs a display; run under xvfb-run.");
  }
  const chromePath = await findChrome();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "melon-e2e-ai-"));
  const extension = await prepareExtension(tmp);
  const extensionId = extensionIdForPath(await fs.realpath(extension));
  const profile = PROFILE ? path.resolve(PROFILE) : path.join(tmp, "profile");
  await fs.mkdir(path.dirname(profile), { recursive: true });
  if (PROFILE) {
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      await fs.rm(path.join(profile, name), { force: true }).catch(() => {});
    }
  }
  const debugPort = await freePort();
  const chrome = spawn(
    chromePath,
    [
      HEADLESS ? "--headless=new" : null,
      HARDWARE ? "--enable-features=Vulkan" : null,
      HARDWARE ? "--disable-gpu-watchdog" : null,
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
    ].filter(Boolean),
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
    log(`Chromium ${chromePath} headless=${HEADLESS} hardware=${HARDWARE} device=${DEVICE || "webgpu"}`);

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
    const renderer = await optionsCdp.evaluate(`(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    })()`);
    if (renderer) log(`WebGL renderer ${renderer}`);
    const adapterInfo = await optionsCdp.evaluate(`(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const info = adapter.info || (await adapter.requestAdapterInfo?.());
      return {
        vendor: info?.vendor || "",
        architecture: info?.architecture || "",
        device: info?.device || "",
        description: info?.description || "",
        features: [...(adapter.features || [])],
      };
    })()`);
    if (adapterInfo) log(`WebGPU adapter ${JSON.stringify(adapterInfo)}`);

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

    let lastProgress = "";
    const state = await waitFor(
      async () => {
        const current = await optionsCdp.evaluate(
          `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.status" })`
        );
        if (current?.state?.status === "error") {
          throw new Error(current.state.error || "model load failed");
        }
        const progress = current?.state?.progress;
        if (progress) {
          const key = `${progress.status}:${progress.file || ""}:${progress.progress ?? ""}`;
          if (key !== lastProgress) {
            lastProgress = key;
            log(
              `model ${progress.status}${progress.file ? ` ${progress.file}` : ""}${
                progress.progress != null ? ` ${progress.progress}%` : ""
              }`
            );
          }
        }
        return current?.state?.status === "ready" ? current.state : null;
      },
      "local model load",
      LOAD_TIMEOUT,
      1000
    );
    const expectedDevice = DEVICE || "webgpu";
    if (!state.device?.startsWith(expectedDevice)) {
      throw new Error(`model did not use ${expectedDevice}: ${state.device}`);
    }
    log(`local model ready on ${state.device}`);

    if (GENERATE) {
      log(`generating up to ${MAX_NEW_TOKENS} tokens`);
      const started = Date.now();
      const reply = await optionsCdp.evaluate(
        `chrome.runtime.sendMessage({
          target: "melon-ai",
          type: "ai.generate",
          messages: [{ role: "user", content: ${JSON.stringify(PROMPT)} }],
          maxNewTokens: ${MAX_NEW_TOKENS},
        })`,
        GENERATE_TIMEOUT
      );
      if (!reply?.ok) {
        throw new Error(`${reply?.error || "local generation failed"}${reply?.stack ? `\n${reply.stack}` : ""}`);
      }
      log(
        `generated ${String(reply.text || "").length} chars in ${Date.now() - started}ms: ${String(reply.text || "").slice(0, 120)}`
      );
    }

    if (PLANNER) {
      vm.runInThisContext(await fs.readFile(path.join(EXT, "ai", "planner.js"), "utf8"), {
        filename: "planner.js",
      });
      const planner = globalThis.MELON_PLANNER;
      let plannerError = null;
      for (let attempt = 0; attempt < PLANNER_ATTEMPTS; attempt++) {
        const messages = planner.messagesForGoal(GOAL, attempt);
        log(
          `planner attempt ${attempt + 1}/${PLANNER_ATTEMPTS}, up to ${PLANNER_MAX_NEW_TOKENS} tokens`
        );
        const started = Date.now();
        const reply = await optionsCdp.evaluate(
          `chrome.runtime.sendMessage({
            target: "melon-ai",
            type: "ai.generate",
            messages: ${JSON.stringify(messages)},
            maxNewTokens: ${PLANNER_MAX_NEW_TOKENS},
          })`,
          GENERATE_TIMEOUT
        );
        log(`planner attempt ${attempt + 1} took ${Date.now() - started}ms`);
        if (!reply?.ok) {
          plannerError = new Error(reply?.error || "local planner generation failed");
          log(`${plannerError.message}${reply?.stack ? `\n${reply.stack}` : ""}`);
          continue;
        }
        const text = String(reply.text || "");
        log(
          `planner output ${text.length} chars: ${text.slice(0, 240).replace(/\s+/g, " ")}`
        );
        try {
          const parsed = extractJsonObject(text);
          const plan = validatePlanGraph(parsed, { goal: GOAL });
          if (!plan.ok) throw new Error(plan.errors.join("; "));
          log(
            `planner graph valid: ${plan.graph.nodes.length} nodes, ${plan.graph.edges.length} edges, ${text.length} chars`
          );
          plannerError = null;
          break;
        } catch (err) {
          plannerError = new Error(`planner attempt ${attempt + 1}: ${err.message}`);
          log(plannerError.message);
        }
      }
      if (plannerError) throw plannerError;
    }

    try {
      await optionsCdp.evaluate(
        `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.unload" })`,
        GENERATE_TIMEOUT
      );
      await waitFor(
        async () => {
          const current = await optionsCdp.evaluate(
            `chrome.runtime.sendMessage({ target: "melon-ai", type: "ai.status" })`
          );
          return current?.state?.status === "idle";
        },
        "model unload",
        120000,
        1000
      );
    } catch (err) {
      log(`unload warning: ${err.message}`);
    }
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

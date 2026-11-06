import { env, pipeline } from "../vendor/transformers.min.js";

const OFFSCREEN_TARGET = "melon-ai";
const BACKGROUND_TARGET = "background";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

const WASM_PATHS = {
  mjs: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.mjs"),
  wasm: chrome.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.wasm"),
};

function configureOnnxBackend(backend) {
  if (!backend?.wasm) return backend;
  backend.wasm.wasmPaths = WASM_PATHS;
  backend.wasm.numThreads = 1;
  backend.wasm.proxy = false;
  return backend;
}

configureOnnxBackend(env.backends.onnx);
try {
  let onnxBackend = env.backends.onnx;
  Object.defineProperty(env.backends, "onnx", {
    configurable: true,
    enumerable: true,
    get() {
      return onnxBackend;
    },
    set(value) {
      onnxBackend = configureOnnxBackend(value);
    },
  });
} catch {
  env.backends.onnx = configureOnnxBackend(env.backends.onnx);
}

let generator = null;
let prepareToken = 0;
let lastProgressAt = 0;
let state = {
  modelId: null,
  model: null,
  status: "idle",
  progress: null,
  device: null,
  error: null,
  loadedAt: null,
};

function publicState() {
  return {
    modelId: state.modelId,
    model: state.model,
    status: state.status,
    progress: state.progress,
    device: state.device,
    error: state.error,
    loadedAt: state.loadedAt,
  };
}

function postState(force = false) {
  try {
    Promise.resolve(
      chrome.runtime.sendMessage({
        target: BACKGROUND_TARGET,
        type: "ai.state",
        state: publicState(),
      })
    ).catch(() => {});
  } catch {}
}

function progressState(progress) {
  const value = Number(progress?.progress);
  return {
    status: progress?.status || "progress",
    file: typeof progress?.file === "string" ? progress.file : null,
    progress: Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null,
    loaded: Number.isFinite(progress?.loaded) ? progress.loaded : null,
    total: Number.isFinite(progress?.total) ? progress.total : null,
  };
}

async function disposeGenerator() {
  if (!generator) return;
  const current = generator;
  generator = null;
  try {
    await current.dispose?.();
  } catch {}
}

async function wgpuSettings(model) {
  if (!navigator.gpu) {
    throw new Error("WebGPU is unavailable in this browser. Local AI requires a WebGPU-capable Chromium build.");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    throw new Error("No WebGPU adapter was found. Check chrome://gpu and try again.");
  }
  const hasF16 = adapter.features.has("shader-f16");
  return {
    device: "webgpu",
    dtype: hasF16 ? model.dtype || "q4f16" : model.dtypeFallback || "q4",
  };
}

async function prepare(model) {
  if (!model?.id || !model?.model) throw new Error("Invalid model selection.");
  if (state.status === "ready" && state.modelId === model.id) return;
  if (state.status === "loading" && state.modelId === model.id) return;

  const token = ++prepareToken;
  await disposeGenerator();
  state = {
    modelId: model.id,
    model: model.model,
    status: "loading",
    progress: null,
    device: null,
    error: null,
    loadedAt: null,
  };
  postState(true);

  try {
    const runtime = await wgpuSettings(model);
    if (token !== prepareToken) return;
    state.device = `${runtime.device} / ${runtime.dtype}`;
    postState(true);

    const pipe = await pipeline("text-generation", model.model, {
      device: runtime.device,
      dtype: runtime.dtype,
      revision: model.revision || "main",
      progress_callback: (progress) => {
        if (token !== prepareToken) return;
        const now = Date.now();
        const next = progressState(progress);
        state.progress = next;
        if (next.progress === 100) {
          postState(true);
          return;
        }
        if (now - lastProgressAt < 120) return;
        lastProgressAt = now;
        postState();
      },
    });

    if (token !== prepareToken) {
      await pipe.dispose?.();
      return;
    }

    generator = pipe;
    state.status = "ready";
    state.progress = { status: "ready", progress: 100 };
    state.loadedAt = Date.now();
    postState(true);
  } catch (err) {
    if (token !== prepareToken) return;
    await disposeGenerator();
    state.status = "error";
    state.error = String(err?.message || err);
    state.progress = null;
    postState(true);
  }
}

async function unload() {
  prepareToken++;
  await disposeGenerator();
  state = {
    modelId: state.modelId,
    model: null,
    status: "idle",
    progress: null,
    device: null,
    error: null,
    loadedAt: null,
  };
  postState(true);
  return publicState();
}

function buildPrompt(messages) {
  const clean = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message.content === "string")
    .slice(-8)
    .map((message) => ({
      role: String(message.role || "user"),
      content: message.content.slice(0, 12000),
    }));

  try {
    return generator.tokenizer.apply_chat_template(clean, {
      tokenize: false,
      add_generation_prompt: true,
    });
  } catch {
    return `${clean.map((message) => `${message.role}: ${message.content}`).join("\n")}\nassistant:`;
  }
}

async function generate({ messages, maxNewTokens = 256 } = {}) {
  if (!generator) throw new Error("No model is loaded. Select a model and choose Download & load.");
  const prompt = buildPrompt(messages);
  const output = await generator(prompt, {
    max_new_tokens: Math.max(1, Math.min(1024, Number(maxNewTokens) || 256)),
    do_sample: false,
    repetition_penalty: 1.05,
    return_full_text: false,
  });
  const raw = Array.isArray(output) ? output[0]?.generated_text || "" : String(output || "");
  const text = raw.startsWith(prompt) ? raw.slice(prompt.length).trim() : raw.trim();
  if (!text) throw new Error("The model returned an empty response.");
  return text;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== OFFSCREEN_TARGET) return false;

  if (message.type === "ai.status") {
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === "ai.prepare") {
    prepare(message.model).catch((err) => {
      state.status = "error";
      state.error = String(err?.message || err);
      postState(true);
    });
    sendResponse({ ok: true, state: publicState() });
    return false;
  }

  if (message.type === "ai.unload") {
    unload()
      .then((next) => sendResponse({ ok: true, state: next }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (message.type === "ai.generate") {
    generate(message)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  return false;
});

postState(true);

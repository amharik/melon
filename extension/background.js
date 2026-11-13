importScripts("adapters.js");
importScripts("adapter-pack.js", "adapter-pack-key.js");
importScripts("ai/models.js", "ai/planner.js");

const ADAPTERS = globalThis.MELON_ADAPTERS;
const ADAPTER_PACK = globalThis.MELON_ADAPTER_PACK;
const ADAPTER_PACK_KEY = globalThis.MELON_ADAPTER_PACK_KEY;
const AI = globalThis.MELON_AI;
const PLANNER = globalThis.MELON_PLANNER;
const CONSENT_VERSION = 1;
const DEFAULTS = {
  hubUrl: "http://127.0.0.1:8787",
  token: "",
  consentVersion: 0,
  consentAt: null,
  aiEnabled: false,
  aiModelId: AI.DEFAULT_MODEL_ID,
  adapterPack: null,
};
const OFFSCREEN_PATH = "ai/offscreen.html";
const OFFSCREEN_TARGET = "melon-ai";

let settings = { ...DEFAULTS };
let activeAdapterPack = null;
let adapterPackState = {
  status: "idle",
  version: 0,
  keyId: null,
  sha256: null,
  checkedAt: null,
  error: null,
};
let adapterPackTimer = null;
let aiState = {
  modelId: AI.DEFAULT_MODEL_ID,
  model: null,
  status: "idle",
  progress: null,
  device: null,
  error: null,
  loadedAt: null,
};
let offscreenCreating = null;
let ws = null;
let reconnectTimer = null;
let backoff = 1000;
let pending = [];
let tabTimer = null;
const HEALTH_TTL = 8000;
const HEALTH_ERROR_TTL = 3000;
const HEALTH_TIMEOUT = 2000;
const healthCache = new Map();
const healthPending = new Map();

function badged(text, color = "#e07a6a") {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

async function loadSettings() {
  settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.token) badged("?");
  else if (Number(settings.consentVersion || 0) < CONSENT_VERSION) badged("!");
}

function adapterPackSnapshot() {
  return {
    ...adapterPackState,
    active: !!activeAdapterPack,
    pack: activeAdapterPack
      ? {
          packId: activeAdapterPack.packId,
          version: activeAdapterPack.version,
          generatedAt: activeAdapterPack.generatedAt,
          expiresAt: activeAdapterPack.expiresAt || null,
          adapters: Object.keys(activeAdapterPack.adapters || {}),
        }
      : null,
  };
}

async function broadcastAdapterPack() {
  if (!activeAdapterPack) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => /^https?:/.test(tab.url || ""))
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, {
            type: "melon.adapters.set",
            adapters: activeAdapterPack.adapters,
            version: activeAdapterPack.version,
          })
          .catch(() => {})
      )
  );
}

async function applyAdapterPack(envelope, { persist = true } = {}) {
  if (!ADAPTER_PACK || !ADAPTER_PACK_KEY?.publicKey) {
    adapterPackState = { ...adapterPackState, status: "error", error: "adapter pack verifier unavailable" };
    return { ok: false, error: adapterPackState.error };
  }
  const result = await ADAPTER_PACK.verify(envelope, {
    publicKey: ADAPTER_PACK_KEY.publicKey,
    keyId: ADAPTER_PACK_KEY.keyId,
    currentVersion: adapterPackState.version,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  if (!result.ok) {
    adapterPackState = {
      ...adapterPackState,
      status: "error",
      checkedAt: Date.now(),
      error: result.errors.join("; "),
    };
    return { ok: false, error: adapterPackState.error };
  }
  const catalogErrors = ADAPTERS.validateCatalog(result.pack.adapters);
  if (catalogErrors.length) {
    adapterPackState = {
      ...adapterPackState,
      status: "error",
      checkedAt: Date.now(),
      error: catalogErrors.join("; "),
    };
    return { ok: false, error: adapterPackState.error };
  }
  if (!result.update && activeAdapterPack) {
    adapterPackState = { ...adapterPackState, status: "current", checkedAt: Date.now() };
    return { ok: true, update: false, pack: activeAdapterPack };
  }
  activeAdapterPack = result.pack;
  ADAPTERS.setCatalog(result.pack.adapters);
  adapterPackState = {
    status: "ready",
    version: result.pack.version,
    keyId: envelope.keyId,
    sha256: result.sha256,
    checkedAt: Date.now(),
    error: null,
  };
  if (persist) await chrome.storage.local.set({ adapterPack: envelope });
  broadcastAdapterPack().catch(() => {});
  return { ok: true, update: true, pack: result.pack };
}

async function loadStoredAdapterPack() {
  if (!settings.adapterPack) return;
  await applyAdapterPack(settings.adapterPack, { persist: false });
}

async function fetchAdapterPack() {
  if (!settings.hubUrl) return { ok: false, error: "hub URL is not configured" };
  const current = adapterPackState.version || 0;
  let response;
  try {
    response = await fetch(
      `${String(settings.hubUrl).replace(/\/+$/, "")}/api/adapter-pack/update?version=${current}`,
      { cache: "no-store" }
    );
  } catch (err) {
    adapterPackState = {
      ...adapterPackState,
      status: "error",
      checkedAt: Date.now(),
      error: String(err?.message || err),
    };
    return { ok: false, error: adapterPackState.error };
  }
  if (response.status === 304) {
    adapterPackState = { ...adapterPackState, status: "current", checkedAt: Date.now(), error: null };
    return { ok: true, update: false };
  }
  if (!response.ok) {
    adapterPackState = {
      ...adapterPackState,
      status: "error",
      checkedAt: Date.now(),
      error: `hub returned ${response.status}`,
    };
    return { ok: false, error: adapterPackState.error };
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch (err) {
    adapterPackState = {
      ...adapterPackState,
      status: "error",
      checkedAt: Date.now(),
      error: `invalid adapter pack JSON: ${String(err?.message || err)}`,
    };
    return { ok: false, error: adapterPackState.error };
  }
  return applyAdapterPack(envelope);
}

function scheduleAdapterPackRefresh() {
  clearInterval(adapterPackTimer);
  adapterPackTimer = setInterval(() => fetchAdapterPack().catch(() => {}), 6 * 60 * 60 * 1000);
}

function aiSnapshot() {
  return {
    ...aiState,
    selectedModelId: settings.aiModelId,
    enabled: !!settings.aiEnabled,
  };
}

function broadcastAiState() {
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: "melon.ai.state", state: aiSnapshot() })).catch(
      () => {}
    );
  } catch {}
}

function setAiState(next, broadcast = true) {
  aiState = { ...aiState, ...next };
  if (broadcast) broadcastAiState();
}

async function hasOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    return contexts.length > 0;
  }
  if (typeof clients !== "undefined" && clients.matchAll) {
    const open = await clients.matchAll();
    return open.some((client) => client.url === url);
  }
  return false;
}

async function ensureOffscreen() {
  if (!settings.aiEnabled) throw new Error("Enable local AI first.");
  if (!chrome.offscreen?.createDocument) {
    throw new Error("Offscreen documents are not available in this browser. Local AI is Chromium-only.");
  }
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Run optional local WebGPU model downloads and inference for Melon.",
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function sendToOffscreen(message) {
  await ensureOffscreen();
  const payload = { target: OFFSCREEN_TARGET, ...message };
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error("The local AI model host did not respond.");
}

async function aiStatus() {
  if (settings.aiEnabled) {
    const open = await hasOffscreenDocument();
    if (open) {
      try {
        const response = await sendToOffscreen({ type: "ai.status" });
        if (response?.state) setAiState(response.state, false);
      } catch {}
    } else if (aiState.status === "ready" || aiState.status === "loading") {
      setAiState(
        { status: "idle", model: null, progress: null, device: null, error: null, loadedAt: null },
        false
      );
    }
  }
  return aiSnapshot();
}

async function selectAiModel(modelId) {
  if (!AI.byId[modelId]) throw new Error("Unknown local AI model.");
  settings.aiModelId = modelId;
  await chrome.storage.local.set({ aiModelId: modelId });
  broadcastAiState();
  return aiStatus();
}

async function setAiEnabled(enabled) {
  if (!enabled) {
    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: "ai.unload" });
      } catch {}
    }
    setAiState(
      { status: "idle", model: null, progress: null, device: null, error: null, loadedAt: null },
      false
    );
  }
  settings.aiEnabled = !!enabled;
  await chrome.storage.local.set({ aiEnabled: !!enabled });
  broadcastAiState();
  return aiStatus();
}

async function prepareAi(modelId) {
  const model = AI.byId[modelId];
  if (!model) throw new Error("Unknown local AI model.");
  if (!settings.aiEnabled) throw new Error("Enable local AI first.");
  const granted = await chrome.permissions.contains({ origins: AI.HF_ORIGINS });
  if (!granted) {
    throw new Error(
      "Model download permission was not granted. Choose Download & load again and allow access to Hugging Face."
    );
  }
  setAiState(
    {
      modelId: model.id,
      model: model.model,
      status: "loading",
      progress: null,
      device: null,
      error: null,
      loadedAt: null,
    },
    false
  );
  try {
    const response = await sendToOffscreen({
      type: "ai.prepare",
      model: {
        id: model.id,
        model: model.model,
        revision: model.revision,
        dtype: model.dtype,
        dtypeFallback: model.dtypeFallback,
      },
    });
    if (!response?.ok) throw new Error(response?.error || "The model host rejected the request.");
    broadcastAiState();
    return aiSnapshot();
  } catch (err) {
    setAiState({ status: "error", error: String(err?.message || err) }, false);
    throw err;
  }
}

async function unloadAi() {
  if (await hasOffscreenDocument()) {
    const response = await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: "ai.unload",
    });
    if (response?.state) setAiState(response.state, false);
  }
  setAiState({ status: "idle", model: null, progress: null, device: null, error: null, loadedAt: null });
  return aiSnapshot();
}

async function testAi() {
  const response = await sendToOffscreen({
    type: "ai.generate",
    messages: [
      {
        role: "user",
        content: "Reply with exactly the word OK and nothing else.",
      },
    ],
    maxNewTokens: 8,
  });
  if (!response?.ok) throw new Error(response?.error || "The model test failed.");
  return response.text;
}

async function planAi(goal, candidates = 1) {
  if (!settings.aiEnabled) throw new Error("Enable local AI first.");
  await aiStatus();
  if (aiState.status !== "ready") {
    throw new Error("Download and load a local AI model before planning.");
  }
  const count = Math.max(1, Math.min(4, Number(candidates) || 1));
  const texts = [];
  for (let index = 0; index < count; index++) {
    const response = await sendToOffscreen({
      type: "ai.generate",
      messages: PLANNER.messagesForGoal(goal, index),
      maxNewTokens: 900,
    });
    if (!response?.ok) {
      if (!texts.length) throw new Error(response?.error || "The planner model failed.");
      break;
    }
    if (response.text) texts.push(response.text);
  }
  if (!texts.length) throw new Error("The planner model returned an empty response.");
  return texts;
}

async function kevRerank(query, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return { ok: false, error: "at least two candidates are required" };
  }
  let response;
  try {
    response = await fetch(`${settings.hubUrl.replace(/\/+$/, "")}/api/kev/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: String(query || "").slice(0, 8000),
        candidates: candidates.slice(0, 32),
      }),
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    return { ok: false, error: data.error || `hub returned ${response.status}` };
  }
  return data;
}

function wsUrl() {
  const base = settings.hubUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/extension?token=${encodeURIComponent(settings.token)}`;
}

function connect() {
  if (!settings.token) {
    badged("?");
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    backoff = 1000;
    badged(Number(settings.consentVersion || 0) < CONSENT_VERSION ? "!" : "");
    send({ type: "hello", name: "melon-extension", tabs: [] });
    broadcastTabs();
    if (pending.length) {
      for (const message of pending.splice(0)) {
        try {
          ws.send(JSON.stringify(message));
        } catch {}
      }
    }
  });

  ws.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "agent.run") {
      await runInTab(message);
    } else if (message.type === "agent.plan") {
      planAi(message.goal, message.candidates)
        .then((texts) =>
          send({
            type: "plan.result",
            requestId: message.requestId,
            ok: true,
            texts,
            text: texts[0] || "",
          })
        )
        .catch((err) =>
          send({
            type: "plan.result",
            requestId: message.requestId,
            ok: false,
            error: String(err?.message || err),
          })
        );
    } else if (message.type === "cancel") {
      sendToTab(message.tabId, { type: "melon.cancel", runId: message.runId }).catch(() => {});
    } else if (message.type === "agent.tool.result") {
      sendToTab(message.tabId, {
        type: "melon.tool.result",
        commandId: message.commandId,
        command: message.command,
        exitCode: message.exitCode,
        output: message.output,
        status: message.status,
        taint: message.taint || "untrusted",
      }).catch(() => {});
    } else if (message.type === "agent.screenshot") {
      captureAndInsert(message.tabId, message.requestId);
    } else if (message.type === "ping") {
      send({ type: "pong", t: message.t });
    }
  });

  ws.addEventListener("close", () => {
    badged("!");
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    try {
      ws?.close();
    } catch {}
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    backoff = Math.min(backoff * 1.6, 30000);
    connect();
  }, backoff);
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      pending.push(message);
    }
  } else {
    pending.push(message);
    if (pending.length > 200) pending.shift();
  }
}

function sendEvent(runId, event) {
  send({ type: "run.event", runId, event });
}

function adapterForUrl(url) {
  try {
    return ADAPTERS.resolveAdapter("auto", new URL(url).hostname);
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function tabHealth(tab) {
  const now = Date.now();
  const cached = healthCache.get(tab.id);
  if (cached && cached.url === tab.url && now - cached.at < cached.ttl) return cached.value;
  if (healthPending.has(tab.id)) return healthPending.get(tab.id).then((entry) => entry.value);

  const adapter = adapterForUrl(tab.url);
  const pending = (async () => {
    if (!adapter) {
      return {
        ttl: HEALTH_ERROR_TTL,
        value: {
          supported: false,
          adapter: null,
          health: null,
          healthError: "no Melon adapter for this site",
          busy: false,
          checkedAt: Date.now(),
        },
      };
    }
    try {
      const response = await withTimeout(
        sendToTab(tab.id, { type: "melon.ping" }),
        HEALTH_TIMEOUT,
        "content script did not answer"
      );
      if (!response?.ok) throw new Error(response?.error || "health check failed");
      return {
        ttl: HEALTH_TTL,
        value: {
          supported: true,
          adapter: response.adapter || adapter.id,
          schemaVersion: response.schemaVersion || null,
          health: response.health || null,
          healthError: null,
          busy: !!response.busy,
          checkedAt: Date.now(),
        },
      };
    } catch (err) {
      const message = String(err?.message || err);
      return {
        ttl: HEALTH_ERROR_TTL,
        value: {
          supported: true,
          adapter: adapter.id,
          health: null,
          healthError: /Could not establish connection|Receiving end does not exist/i.test(message)
            ? "content script not loaded; reload the tab"
            : message,
          busy: false,
          checkedAt: Date.now(),
        },
      };
    }
  })();

  healthPending.set(tab.id, pending);
  try {
    const entry = await pending;
    healthCache.set(tab.id, { ...entry, url: tab.url, at: Date.now() });
    return entry.value;
  } finally {
    healthPending.delete(tab.id);
  }
}

function tabControlId(tabId) {
  const id = Number(tabId);
  return Number.isFinite(id) ? `T-${id.toString(36).toUpperCase().padStart(3, "0")}` : "T-?";
}

async function tabs() {
  const list = await chrome.tabs.query({});
  return Promise.all(
    list
      .filter((tab) => /^https?:/.test(tab.url || ""))
      .map(async (tab) => ({
        ...(await tabHealth(tab)),
        id: tab.id,
        controlId: tabControlId(tab.id),
        windowId: tab.windowId,
        title: tab.title || tab.url || `Tab ${tab.id}`,
        url: tab.url || "",
        active: !!tab.active,
        attached: true,
      }))
  );
}

async function broadcastTabs() {
  send({ type: "tabs", tabs: await tabs() });
}

function scheduleTabs() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(() => broadcastTabs().catch(() => {}), 500);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["adapters.js", "content.js"] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function captureAndInsert(tabId, requestId) {
  try {
    const id = Number(tabId);
    const tab = await chrome.tabs.get(id);
    if (!tab.active) await chrome.tabs.update(id, { active: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const response = await sendToTab(id, {
      type: "melon.screenshot.insert",
      dataUrl,
      name: `melon-${Date.now()}.png`,
    });
    send({
      type: "screenshot.result",
      requestId,
      tabId,
      ok: !!response?.ok,
      error: response?.error || null,
    });
  } catch (err) {
    send({
      type: "screenshot.result",
      requestId,
      tabId,
      ok: false,
      error: String(err?.message || err),
    });
  }
}

async function runInTab(message) {
  const tabId = Number(message.tabId);
  if (!Number.isFinite(tabId)) {
    sendEvent(message.runId, { type: "error", error: { message: "invalid tab id" } });
    return;
  }
  if (Number(settings.consentVersion || 0) < CONSENT_VERSION) {
    sendEvent(message.runId, {
      type: "error",
      error: {
        message:
          "Bridge consent has not been accepted. Open the Melon extension options and accept the one-time consent before running real tabs.",
      },
    });
    return;
  }
  try {
    const response = await sendToTab(tabId, {
      type: "melon.run",
      runId: message.runId,
      controlId: tabControlId(tabId),
      prompt: message.prompt,
      adapter: message.adapter || "auto",
      retrievePageContext: !!message.retrievePageContext,
    });
    if (!response?.ok) {
      sendEvent(message.runId, {
        type: "error",
        error: { message: response?.error || "content script did not accept the run" },
      });
    }
  } catch (err) {
    sendEvent(message.runId, {
      type: "error",
      error: { message: `could not reach tab ${tabId}: ${err.message}` },
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "background" && message.type === "ai.state") {
    if (message.state) setAiState(message.state);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "run.event") {
    send({ type: "run.event", runId: message.runId, event: message.event });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "melon.tool.request") {
    send({
      type: "tool.request",
      runId: message.runId || null,
      tabId: sender.tab?.id ?? null,
      command: String(message.command || "").slice(0, 500),
      reason: String(message.reason || "").slice(0, 400),
      taint: message.taint || "untrusted",
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "melon.adapters.pack") {
    sendResponse({
      ok: true,
      ...adapterPackSnapshot(),
      adapters: activeAdapterPack?.adapters || null,
    });
    return false;
  }
  if (message?.type === "melon.adapters.refresh") {
    fetchAdapterPack()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "content.ready") {
    scheduleTabs();
    if (sender.tab?.id && activeAdapterPack) {
      chrome.tabs
        .sendMessage(sender.tab.id, {
          type: "melon.adapters.set",
          adapters: activeAdapterPack.adapters,
          version: activeAdapterPack.version,
        })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "tabs.refresh") {
    broadcastTabs().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "melon.ai.status") {
    aiStatus()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.ai.select") {
    selectAiModel(message.modelId)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.ai.enable") {
    setAiEnabled(message.enabled)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.ai.prepare") {
    prepareAi(message.modelId)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.ai.unload") {
    unloadAi()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.kev.rerank") {
    kevRerank(message.query, message.candidates)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "melon.ai.test") {
    testAi()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.aiEnabled || changes.aiModelId) {
    loadSettings().then(() => broadcastAiState());
  }
  if (changes.consentVersion) {
    loadSettings().then(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        badged(Number(settings.consentVersion || 0) < CONSENT_VERSION ? "!" : "");
      }
    });
  }
  if (changes.hubUrl || changes.token) {
    loadSettings().then(() => {
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      ws = null;
      connect();
      fetchAdapterPack().catch(() => {});
    });
  }
});

chrome.tabs.onCreated.addListener(scheduleTabs);
chrome.tabs.onRemoved.addListener((tabId) => {
  healthCache.delete(tabId);
  healthPending.delete(tabId);
  scheduleTabs();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status || info.url || info.title) scheduleTabs();
});
chrome.tabs.onActivated.addListener(scheduleTabs);

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  if (!settings.token || Number(settings.consentVersion || 0) < CONSENT_VERSION) {
    chrome.runtime.openOptionsPage();
  }
});

loadSettings().then(async () => {
  await loadStoredAdapterPack();
  connect();
  if (settings.aiEnabled) aiStatus().catch(() => {});
  fetchAdapterPack().catch(() => {});
  scheduleAdapterPackRefresh();
});
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}, 20000);

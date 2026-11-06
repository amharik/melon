const AI = globalThis.MELON_AI;
const CONSENT_VERSION = 1;
const DEFAULTS = {
  hubUrl: "http://127.0.0.1:8787",
  token: "",
  consentVersion: 0,
  consentAt: null,
  aiEnabled: false,
  aiModelId: AI.DEFAULT_MODEL_ID,
};

const $ = (id) => document.getElementById(id);
const hubInput = $("hub");
const tokenInput = $("token");
const consentInput = $("consent");
const statusEl = $("status");
const aiEnabledInput = $("ai-enabled");
const aiModelInput = $("ai-model");
const aiModelDetails = $("ai-model-details");
const aiDownloadButton = $("ai-download");
const aiTestButton = $("ai-test");
const aiUnloadButton = $("ai-unload");
const aiProgress = $("ai-progress");
const aiStatusEl = $("ai-status");
const aiResult = $("ai-result");

let aiPollTimer = null;
let aiState = null;
let consentAt = null;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function setAiStatus(text, kind = "") {
  aiStatusEl.textContent = text;
  aiStatusEl.className = kind;
}

function normalizeHub(value) {
  return (value || DEFAULTS.hubUrl).trim().replace(/\/+$/, "");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function modelLabel(modelId) {
  return AI.byId[modelId]?.label || modelId || "No model";
}

function populateModels(selectedId) {
  aiModelInput.replaceChildren();
  for (const model of AI.MODELS) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.label} - ~${formatBytes(model.approxBytes)}${
      model.recommended ? " (recommended)" : ""
    }`;
    aiModelInput.append(option);
  }
  aiModelInput.value = AI.byId[selectedId] ? selectedId : AI.DEFAULT_MODEL_ID;
}

function renderModelDetails() {
  const model = AI.byId[aiModelInput.value] || AI.byId[AI.DEFAULT_MODEL_ID];
  aiModelDetails.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = model.label;
  const meta = document.createElement("span");
  meta.textContent = `${model.model} - ${model.params} - ~${formatBytes(model.approxBytes)} - ${model.license}`;
  const note = document.createElement("span");
  note.textContent = model.note;
  aiModelDetails.append(title, meta, note);
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  hubInput.value = settings.hubUrl || DEFAULTS.hubUrl;
  tokenInput.value = settings.token || "";
  consentInput.checked = Number(settings.consentVersion || 0) >= CONSENT_VERSION;
  consentAt = settings.consentAt || null;
  aiEnabledInput.checked = !!settings.aiEnabled;
  populateModels(settings.aiModelId);
  renderModelDetails();
  if (!settings.token) {
    setStatus("No token yet. Start the hub, then paste its token.");
  } else if (!consentInput.checked) {
    setStatus("Accept the bridge consent to run real tabs.");
  }
  setAiStatus(
    settings.aiEnabled
      ? "Checking local model host..."
      : "Local AI is off. Deterministic adapters are unaffected."
  );
  updateAiButtons();
  if (settings.aiEnabled) refreshAiStatus();
}

async function save() {
  const hubUrl = normalizeHub(hubInput.value);
  const token = tokenInput.value.trim();
  try {
    const url = new URL(hubUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("hub URL must be http or https");
  } catch (err) {
    setStatus(String(err.message || err), "bad");
    return false;
  }
  const consentVersion = consentInput.checked ? CONSENT_VERSION : 0;
  const nextConsentAt = consentVersion ? consentAt || Date.now() : null;
  await chrome.storage.local.set({ hubUrl, token, consentVersion, consentAt: nextConsentAt });
  consentAt = nextConsentAt;
  hubInput.value = hubUrl;
  const consentNote = consentVersion ? "" : " Real-tab runs stay blocked until consent is accepted.";
  setStatus(
    token
      ? `Saved. Reconnecting the bridge.${consentNote}`
      : `Saved. Add a token to connect.${consentNote}`,
    token && consentVersion ? "good" : ""
  );
  return true;
}

async function test() {
  const hubUrl = normalizeHub(hubInput.value);
  setStatus("Testing...");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${hubUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    setStatus(`Hub online: ${body.name || "melon"} ${body.version || ""}`.trim(), "good");
  } catch (err) {
    setStatus(
      `Cannot reach ${hubUrl}: ${String(err.message || err)}\nIs the hub running on that port?`,
      "bad"
    );
  }
}

function updateAiButtons() {
  const enabled = aiEnabledInput.checked;
  const status = aiState?.status || "idle";
  const selectedId = aiModelInput.value;
  const loadedSelected = status === "ready" && aiState?.modelId === selectedId;
  aiDownloadButton.disabled = !enabled || status === "loading";
  aiTestButton.disabled = !loadedSelected;
  aiUnloadButton.disabled = status !== "ready" && status !== "loading";
  aiModelInput.disabled = status === "loading";
}

function renderAiState(state) {
  aiState = state || aiState;
  if (!aiState) return;
  const selectedId = aiState.selectedModelId || aiModelInput.value;
  const loadedId = aiState.modelId;
  const selected = AI.byId[selectedId] || AI.byId[aiModelInput.value];
  const loaded = AI.byId[loadedId];

  if (aiState.status === "loading") {
    const progress = aiState.progress;
    const value = Number(progress?.progress);
    aiProgress.hidden = false;
    if (Number.isFinite(value)) aiProgress.value = value;
    else aiProgress.removeAttribute("value");
    const file = progress?.file ? ` - ${progress.file.split("/").pop()}` : "";
    const amount =
      Number.isFinite(progress?.loaded) && Number.isFinite(progress?.total) && progress.total > 0
        ? ` (${formatBytes(progress.loaded)} / ${formatBytes(progress.total)})`
        : "";
    setAiStatus(`Downloading and loading ${selected?.label || modelLabel(selectedId)}${file}${amount}`, "");
  } else if (aiState.status === "ready" && loadedId === selectedId) {
    aiProgress.hidden = true;
    setAiStatus(
      `Ready: ${loaded?.label || modelLabel(loadedId)} on ${aiState.device || "WebGPU"}.`,
      "good"
    );
  } else if (aiState.status === "ready") {
    aiProgress.hidden = true;
    setAiStatus(
      `Loaded: ${loaded?.label || modelLabel(loadedId)}. Selected: ${
        selected?.label || modelLabel(selectedId)
      }. Choose Download & load to switch.`
    );
  } else if (aiState.status === "error") {
    aiProgress.hidden = true;
    setAiStatus(aiState.error || "Local AI failed to load.", "bad");
  } else {
    aiProgress.hidden = true;
    setAiStatus(
      selected
        ? `${selected.label} is not loaded. Choose Download & load to fetch ~${formatBytes(
            selected.approxBytes
          )}.`
        : "Local AI is off."
    );
  }
  updateAiButtons();
  if (aiState.status !== "loading") stopAiPolling();
}

async function refreshAiStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "melon.ai.status" });
    if (!response?.ok) throw new Error(response?.error || "Could not read local AI status.");
    renderAiState(response.state);
  } catch (err) {
    setAiStatus(String(err?.message || err), "bad");
    stopAiPolling();
  }
}

function startAiPolling() {
  stopAiPolling();
  aiPollTimer = setInterval(refreshAiStatus, 900);
}

function stopAiPolling() {
  clearInterval(aiPollTimer);
  aiPollTimer = null;
}

async function persistAiSettings() {
  const aiEnabled = aiEnabledInput.checked;
  const aiModelId = AI.byId[aiModelInput.value] ? aiModelInput.value : AI.DEFAULT_MODEL_ID;
  try {
    await chrome.storage.local.set({ aiEnabled, aiModelId });
    const selected = await chrome.runtime.sendMessage({ type: "melon.ai.select", modelId: aiModelId });
    const enabled = await chrome.runtime.sendMessage({ type: "melon.ai.enable", enabled: aiEnabled });
    if (selected?.ok) renderAiState(selected.state);
    if (enabled?.ok) renderAiState(enabled.state);
    if (!enabled?.ok) setAiStatus(enabled?.error || "Could not update local AI settings.", "bad");
  } catch (err) {
    setAiStatus(String(err?.message || err), "bad");
  }
  updateAiButtons();
}

async function downloadModel() {
  if (!aiEnabledInput.checked) {
    setAiStatus("Enable local AI first.", "bad");
    return;
  }
  const model = AI.byId[aiModelInput.value] || AI.byId[AI.DEFAULT_MODEL_ID];
  aiDownloadButton.disabled = true;
  aiResult.hidden = true;
  setAiStatus("Requesting Hugging Face download permission...");
  try {
    const granted = await chrome.permissions.request({ origins: AI.HF_ORIGINS });
    if (!granted) {
      throw new Error(
        "Model download permission was denied. Allow access to huggingface.co to download a model."
      );
    }
    setAiStatus(`Starting ${model.label} download...`);
    const response = await chrome.runtime.sendMessage({
      type: "melon.ai.prepare",
      modelId: model.id,
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start the model download.");
    renderAiState(response.state);
    startAiPolling();
    refreshAiStatus();
  } catch (err) {
    setAiStatus(String(err?.message || err), "bad");
    updateAiButtons();
  }
}

async function testModel() {
  aiResult.hidden = true;
  setAiStatus("Running a short local test...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "melon.ai.test" });
    if (!response?.ok) throw new Error(response?.error || "The model test failed.");
    aiResult.hidden = false;
    aiResult.textContent = response.text;
    setAiStatus("Model responded locally.", "good");
  } catch (err) {
    setAiStatus(String(err?.message || err), "bad");
  }
}

async function unloadModel() {
  setAiStatus("Unloading model from memory...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "melon.ai.unload" });
    if (!response?.ok) throw new Error(response?.error || "Could not unload the model.");
    aiState = response.state;
    renderAiState(response.state);
  } catch (err) {
    setAiStatus(String(err?.message || err), "bad");
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("open").addEventListener("click", () => {
  chrome.tabs.create({ url: normalizeHub(hubInput.value) + "/" });
});
tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") save();
});

aiEnabledInput.addEventListener("change", persistAiSettings);
aiModelInput.addEventListener("change", async () => {
  renderModelDetails();
  aiResult.hidden = true;
  await persistAiSettings();
  if (aiState?.status === "ready" && aiState.modelId !== aiModelInput.value) {
    setAiStatus(
      `Loaded: ${modelLabel(aiState.modelId)}. Selected: ${modelLabel(
        aiModelInput.value
      )}. Choose Download & load to switch.`
    );
  }
  updateAiButtons();
});
aiDownloadButton.addEventListener("click", downloadModel);
aiTestButton.addEventListener("click", testModel);
aiUnloadButton.addEventListener("click", unloadModel);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "melon.ai.state" && message.state) {
    renderAiState(message.state);
    if (message.state.status === "loading") startAiPolling();
  }
  return false;
});

load();

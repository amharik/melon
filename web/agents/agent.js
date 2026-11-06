import { PROTOCOL, channelName, uid } from "../shared/protocol.js";
import { buildResponse, roleLabel, streamText } from "../shared/simulator.js";

const params = new URLSearchParams(location.search);
const role = (params.get("role") || "claude").toLowerCase();
const room = params.get("room") || "demo";
const name = params.get("name") || roleLabel(role);
const agentId = uid("agent");
const bus = new BroadcastChannel(channelName(room));

const $ = (id) => document.getElementById(id);
$("role-name").textContent = name;
$("agent-id").textContent = agentId;
$("room").textContent = room;
$("bus-badge").textContent = "bus: open";
$("bus-badge").classList.add("ok");

let busy = false;
let currentRun = null;
let controller = null;
const peers = new Map();

function announce() {
  bus.postMessage({
    protocol: PROTOCOL,
    type: "presence",
    agent: { id: agentId, role, name, room, mode: $("mode").value, lastSeen: Date.now() },
  });
}

function addMessage(kind, text, meta = "") {
  const article = document.createElement("article");
  article.className = `msg ${kind}`;
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    article.append(m);
  }
  const p = document.createElement("p");
  p.textContent = text;
  article.append(p);
  $("transcript").append(article);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return p;
}

function setBusy(value, label = "") {
  busy = value;
  document.body.classList.toggle("is-busy", value);
  if (label) $("bus-badge").textContent = label;
  else $("bus-badge").textContent = "bus: open";
}

function targeted(message) {
  if (message.agentId) return message.agentId === agentId;
  if (message.role) return message.role === role;
  return false;
}

async function* hubLlm(prompt, signal) {
  const response = await fetch("/api/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content:
            `You are ${name}, one participant in a multi-agent design review. ` +
            "Be concise, concrete and opinionated. Do not mention that you are a demo.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`hub LLM unavailable (${response.status}) ${detail.slice(0, 160)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      if (event.error) throw new Error(event.error);
      if (event.text) yield event.text;
    }
  }
}

async function generate(prompt, onChunk, signal) {
  const mode = $("mode").value;
  if (mode === "llm") {
    let full = "";
    for await (const chunk of hubLlm(prompt, signal)) {
      full += chunk;
      onChunk(chunk);
    }
    return full;
  }
  const text = buildResponse(role, prompt, "");
  let full = "";
  await streamText(
    text,
    (chunk) => {
      full += chunk;
      onChunk(chunk);
    },
    { signal, delay: 18 },
  );
  return full;
}

async function handleRun(message, manual = false) {
  if (busy) {
    if (!manual) {
      bus.postMessage({
        protocol: PROTOCOL,
        type: "error",
        runId: message.runId,
        agentId,
        error: { message: "agent tab is busy" },
      });
    }
    return;
  }
  const prompt = String(message.prompt || "").trim();
  if (!prompt) return;

  busy = true;
  currentRun = message.runId;
  controller = new AbortController();
  setBusy(true, "bus: running");

  addMessage("user", prompt, `you → ${name}`);
  const paragraph = addMessage("agent", "", name);

  try {
    let full = "";
    await generate(
      prompt,
      (chunk) => {
        full += chunk;
        paragraph.textContent += chunk;
        $("transcript").scrollTop = $("transcript").scrollHeight;
        if (!manual) {
          bus.postMessage({
            protocol: PROTOCOL,
            type: "chunk",
            runId: message.runId,
            agentId,
            text: chunk,
          });
        }
      },
      controller.signal,
    );
    paragraph.textContent = full;
    if (!manual) {
      bus.postMessage({
        protocol: PROTOCOL,
        type: "done",
        runId: message.runId,
        agentId,
        text: full,
      });
    }
  } catch (err) {
    if (err.name === "AbortError") {
      paragraph.textContent += "\n\n[cancelled]";
      if (!manual) {
        bus.postMessage({
          protocol: PROTOCOL,
          type: "cancelled",
          runId: message.runId,
          agentId,
        });
      }
    } else {
      paragraph.textContent += `\n\nError: ${err.message}`;
      paragraph.parentElement.classList.add("error");
      if (!manual) {
        bus.postMessage({
          protocol: PROTOCOL,
          type: "error",
          runId: message.runId,
          agentId,
          error: { message: err.message },
        });
      }
    }
  } finally {
    busy = false;
    currentRun = null;
    controller = null;
    setBusy(false);
  }
}

bus.onmessage = (event) => {
  const message = event.data;
  if (!message || message.protocol !== PROTOCOL) return;
  switch (message.type) {
    case "presence.request":
      announce();
      break;
    case "presence":
      if (message.agent?.id && message.agent.id !== agentId) {
        peers.set(message.agent.id, { ...message.agent, lastSeen: Date.now() });
      }
      break;
    case "run":
      if (targeted(message)) handleRun(message);
      break;
    case "cancel":
      if (message.runId === currentRun) controller?.abort();
      break;
  }
};

$("announce").addEventListener("click", announce);
$("mode").addEventListener("change", announce);

$("compose").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = $("manual").value.trim();
  if (!prompt) return;
  $("manual").value = "";
  handleRun({ runId: uid("manual"), prompt }, true);
});

announce();
setInterval(announce, 5000);

checkHub();
async function checkHub() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const data = await res.json();
    const badge = $("hub-badge");
    badge.textContent = data.llm ? "hub: llm ready" : "hub: no llm";
    badge.classList.toggle("ok", !!data.llm);
    badge.classList.toggle("bad", !data.llm);
  } catch {
    $("hub-badge").textContent = "hub: offline";
    $("hub-badge").classList.add("bad");
  }
}

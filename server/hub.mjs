#!/usr/bin/env node
// Melon local hub.
//
// One process, no dependencies:
//   - serves the canvas and demo agent tabs from web/
//   - brokers runs and optional graph planning between the canvas and extension
//   - adapts opencode serve (HTTP + SSE) and any OpenAI-compatible LLM endpoint
//
// It owns no model inference; opencode, LLM, and Kev calls are external. It
// stores no conversation history.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractJsonObject, validatePlanGraph } from "../web/shared/planner.js";
import { createKevClient } from "./kev.mjs";
import { createAuditLog } from "./audit.mjs";
import { packEtag, packSummary, readPackFile } from "./adapter-pack.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const VERSION = "0.1.0";
const TOKEN_FILE = path.join(ROOT, ".melon-token");
const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
const LLM_URL = (process.env.LLM_URL || "").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "";
const LLM_KEY = process.env.LLM_KEY || "";
const KEV_URL = (process.env.KEV_URL || "").replace(/\/+$/, "");
const KEV_MODEL = process.env.KEV_MODEL || "kev";
const AUDIT_LOG = process.env.MELON_AUDIT_LOG
  ? path.resolve(process.env.MELON_AUDIT_LOG)
  : /^(1|true|yes)$/i.test(process.env.MELON_AUDIT || "")
    ? path.join(ROOT, ".melon", "audit.jsonl")
    : "";
const MAX_BODY = 2 * 1024 * 1024;
const ADAPTER_PACK_FILE = process.env.MELON_ADAPTER_PACK_FILE
  ? path.resolve(process.env.MELON_ADAPTER_PACK_FILE)
  : path.join(ROOT, "adapters", "adapter-pack.json");
const ADAPTER_PACK_PUB_FILE = process.env.MELON_ADAPTER_PACK_PUB_FILE
  ? path.resolve(process.env.MELON_ADAPTER_PACK_PUB_FILE)
  : path.join(ROOT, "adapters", "adapter-pack.pub.json");
const kev = createKevClient({ url: KEV_URL, model: KEV_MODEL });
const audit = createAuditLog({ file: AUDIT_LOG });

let TOKEN = process.env.MELON_TOKEN || "";
if (!TOKEN) {
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, TOKEN + "\n", { mode: 0o600 });
}

const sseClients = new Set();
const extClients = new Set();
const runs = new Map();
const opencodeStreams = new Map();
const plans = new Map();
let adapterPackCache = { mtimeMs: 0, envelope: null, etag: null, error: null };

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function sseSend(res, event) {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    sseClients.delete(res);
  }
}

function broadcast(event) {
  for (const res of sseClients) sseSend(res, event);
}

function broadcastTabs() {
  broadcast({ type: "tabs", tabs: aggregateTabs() });
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function newRun(id, target) {
  const tab =
    target.type === "extension"
      ? aggregateTabs().find((item) => String(item.id) === String(target.tabId))
      : null;
  const run = {
    id,
    target,
    createdAt: Date.now(),
    text: "",
    timer: null,
    controller: new AbortController(),
    sessionId: target.sessionId || null,
    base: null,
    audit: {
      runId: id,
      target: target.type,
      node: target.node || null,
      label: target.label || null,
      adapter: target.adapter || null,
      tabId: target.tabId ?? null,
      controlId: tab?.controlId || null,
    },
  };
  runs.set(id, run);
  audit.write({ event: "run.start", ...run.audit });
  run.timer = setTimeout(() => {
    finishRun(id, { type: "error", error: { message: "run timed out" }, timedOut: true });
  }, target.timeoutMs || 300000);
  return run;
}

function finishRun(id, event) {
  const run = runs.get(id);
  if (!run) return;
  clearTimeout(run.timer);
  run.controller.abort();
  runs.delete(id);
  audit.write({
    event: "run.end",
    ...run.audit,
    status: event.type === "done" ? "done" : event.type === "cancelled" ? "cancelled" : "error",
    durationMs: Date.now() - run.createdAt,
    chars: String(event.text ?? run.text ?? "").length,
    timedOut: !!event.timedOut,
  });
  broadcast({ type: "run.event", runId: id, event });
}

function runEvent(id, event) {
  const run = runs.get(id);
  if (!run) return;
  if (event.type === "chunk") {
    run.text += event.text || "";
    broadcast({ type: "run.event", runId: id, event });
    return;
  }
  if (event.type === "done") {
    event.text = event.text ?? run.text;
    finishRun(id, event);
    return;
  }
  finishRun(id, event);
}

function abortRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  if (run.target.type === "extension") {
    for (const client of extClients) {
      if (client.tabs.some((t) => String(t.id) === String(run.target.tabId))) {
        sendWs(client, { type: "cancel", runId: id });
      }
    }
    finishRun(id, { type: "cancelled" });
  } else if (run.target.type === "opencode" && run.sessionId) {
    const base = run.base || OPENCODE_URL;
    fetch(`${base}/session/${encodeURIComponent(run.sessionId)}/abort`, { method: "POST" }).catch(() =>
      fetch(`${base}/api/session/${encodeURIComponent(run.sessionId)}/abort`, { method: "POST" }).catch(() => {}),
    );
    finishRun(id, { type: "error", error: { message: "cancelled by user" } });
  } else {
    finishRun(id, { type: "error", error: { message: "cancelled by user" } });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Extension WebSocket bridge
// ---------------------------------------------------------------------------

function aggregateTabs() {
  const byId = new Map();
  for (const client of extClients) {
    for (const tab of client.tabs) {
      byId.set(String(tab.id), {
        id: tab.id,
        controlId: tab.controlId || null,
        title: tab.title || tab.url || `Tab ${tab.id}`,
        url: tab.url || "",
        active: !!tab.active,
        attached: tab.attached !== false,
        supported: tab.supported,
        adapter: tab.adapter || null,
        schemaVersion: tab.schemaVersion || null,
        health: tab.health || null,
        healthError: tab.healthError || null,
        busy: !!tab.busy,
        checkedAt: tab.checkedAt || null,
      });
    }
  }
  return [...byId.values()];
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sendFrame(socket, opcode, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function sendWs(client, object) {
  sendFrame(client.socket, 0x1, Buffer.from(JSON.stringify(object)));
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  if (client.buffer.length > 16 * 1024 * 1024) {
    client.socket.destroy();
    return;
  }
  while (true) {
    const buffer = client.buffer;
    if (buffer.length < 2) return;
    const b0 = buffer[0];
    const b1 = buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (!masked) {
      client.socket.destroy();
      return;
    }
    if (buffer.length < offset + 4 + length) return;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    client.buffer = buffer.subarray(offset + 4 + length);

    if (opcode === 0x8) {
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client.socket, 0xa, payload);
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x0) {
      const text = payload.toString("utf8");
      client.fragment = opcode === 0x0 ? (client.fragment || "") + text : text;
      if (!fin) continue;
      const complete = client.fragment || text;
      client.fragment = "";
      if (opcode === 0x0) {
        handleExtMessage(client, complete);
      } else {
        handleExtMessage(client, text);
      }
    }
  }
}

function handleExtMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === "hello" || message.type === "tabs") {
    client.tabs = Array.isArray(message.tabs) ? message.tabs : client.tabs;
    client.name = message.name || client.name;
    broadcastTabs();
    return;
  }
  if (message.type === "run.event" && message.runId) {
    runEvent(String(message.runId), message.event || {});
    return;
  }
  if (message.type === "plan.result" && message.requestId) {
    const plan = plans.get(String(message.requestId));
    if (!plan || plan.client !== client) return;
    clearTimeout(plan.timer);
    plans.delete(String(message.requestId));
    if (message.ok) {
      const texts = Array.isArray(message.texts)
        ? message.texts.map((text) => String(text || "")).filter(Boolean)
        : [String(message.text || "")].filter(Boolean);
      if (texts.length) plan.resolve({ texts });
      else plan.reject(new Error("planner returned no text"));
    } else plan.reject(new Error(message.error || "planner failed"));
    return;
  }
  if (message.type === "pong") return;
}

function startExtensionRun(run) {
  const tabId = String(run.target.tabId);
  const client = [...extClients].find((c) => c.tabs.some((t) => String(t.id) === tabId));
  if (!client) {
    finishRun(run.id, {
      type: "error",
      error: { message: `no extension tab ${tabId}; is the Melon extension connected and the tab loaded?` },
    });
    return;
  }
  run.target.tabId = tabId;
  sendWs(client, {
    type: "agent.run",
    runId: run.id,
    tabId: run.target.tabId,
    prompt: run.target.prompt,
    adapter: run.target.adapter || "auto",
    retrievePageContext: !!run.target.retrievePageContext,
  });
}

function requestPlan(goal, candidateCount = 1) {
  const client = [...extClients][0];
  if (!client) return Promise.reject(new Error("Melon extension is not connected."));
  const requestId = crypto.randomBytes(9).toString("base64url");
  return new Promise((resolve, reject) => {
    const timeout = candidateCount > 1 ? 180000 : 90000;
    const timer = setTimeout(() => {
      plans.delete(requestId);
      reject(new Error("planner timed out"));
    }, timeout);
    plans.set(requestId, { client, resolve, reject, timer });
    sendWs(client, { type: "agent.plan", requestId, goal, candidates: candidateCount });
  });
}

function planDescription(goal, graph) {
  const nodes = graph.nodes
    .map((node) => {
      const adapter = node.config?.adapter ? `:${node.config.adapter}` : "";
      const topic = node.config?.topic ? ` topic=${node.config.topic}` : "";
      return `${node.label}(${node.kind}${adapter}${topic})`;
    })
    .join("; ");
  const edges = graph.edges
    .map((edge) => `${edge.from.node}.${edge.from.port}->${edge.to.node}.${edge.to.port}`)
    .join("; ");
  return `Goal: ${goal}\nNodes: ${nodes}\nEdges: ${edges}`;
}

async function choosePlan(goal, valid) {
  if (valid.length <= 1 || !kev.enabled) {
    return { plan: valid[0], reranked: false, rerank: null };
  }
  try {
    const result = await kev.rerank(
      goal,
      valid.map((item, index) => ({
        id: `plan-${index + 1}`,
        text: planDescription(goal, item.graph),
      })),
      {
        topK: 1,
        instructions: "Which candidate graph best satisfies the goal with a coherent, minimal dataflow?",
      }
    );
    const chosenId = result.selected[0];
    const index = valid.findIndex((_, i) => `plan-${i + 1}` === chosenId);
    return {
      plan: index >= 0 ? valid[index] : valid[0],
      reranked: true,
      rerank: result,
    };
  } catch (err) {
    console.warn(`[kev] planner rerank failed: ${err.message}`);
    return { plan: valid[0], reranked: false, rerank: null, rerankError: err.message };
  }
}

// ---------------------------------------------------------------------------
// opencode adapter (serve v1 + v2 tolerant)
// ---------------------------------------------------------------------------

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data, text };
}

async function createOpencodeSession(base, signal) {
  const attempts = [
    { url: `${base}/session`, body: { title: "melon canvas" } },
    { url: `${base}/api/session`, body: { title: "melon canvas" } },
  ];
  for (const attempt of attempts) {
    try {
      const { res, data } = await postJson(attempt.url, attempt.body, signal);
      if (res.ok && data && (data.id || data.sessionID || data.data?.id)) {
        return data.id || data.sessionID || data.data.id;
      }
    } catch {}
  }
  throw new Error(`could not create an opencode session at ${base}`);
}

async function sendOpencodePrompt(base, sessionId, prompt, signal) {
  const attempts = [
    {
      url: `${base}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      body: { parts: [{ type: "text", text: prompt }] },
    },
    {
      url: `${base}/session/${encodeURIComponent(sessionId)}/message`,
      body: { parts: [{ type: "text", text: prompt }] },
    },
    {
      url: `${base}/api/session/${encodeURIComponent(sessionId)}/prompt`,
      body: { text: prompt },
    },
  ];
  let last = "";
  for (const attempt of attempts) {
    try {
      const { res, text } = await postJson(attempt.url, attempt.body, signal);
      if (res.ok) return attempt.url;
      last = `${res.status} ${text.slice(0, 160)}`;
    } catch (err) {
      last = err.message;
    }
  }
  throw new Error(`opencode prompt failed: ${last}`);
}

function textFromOpencodeEvent(data) {
  const props = data.properties || data;
  const part = props.part || props.delta || {};
  const type = part.type || props.type;
  if (type && type !== "text" && type !== "reasoning" && type !== "assistant") return null;
  if (type === "reasoning") return null;
  if (typeof props.delta === "string") return { text: props.delta, mode: "delta" };
  if (typeof part.delta === "string") return { text: part.delta, mode: "delta" };
  if (typeof props.text === "string") return { text: props.text, mode: "cumulative" };
  if (typeof part.text === "string") return { text: part.text, mode: "cumulative" };
  if (typeof props.part?.text === "string") return { text: props.part.text, mode: "cumulative" };
  return null;
}

function sessionFromOpencodeEvent(data) {
  const props = data.properties || data;
  return (
    props.sessionID ||
    props.part?.sessionID ||
    props.info?.sessionID ||
    props.message?.sessionID ||
    data.sessionID ||
    null
  );
}

function opencodeRuns(base, sessionId) {
  return [...runs.values()].filter(
    (r) => r.target.type === "opencode" && r.sessionId === sessionId && (r.base || OPENCODE_URL) === base,
  );
}

function ensureOpencodeStream(base) {
  const existing = opencodeStreams.get(base);
  if (existing) return existing.ready;

  const entry = {
    base,
    controller: new AbortController(),
    lastText: new Map(),
    ready: null,
    closed: false,
  };
  opencodeStreams.set(base, entry);

  entry.ready = (async () => {
    const candidates = [`${base}/event`, `${base}/api/event`];
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: entry.controller.signal,
        });
        if (!res.ok || !res.body) continue;
        const ctype = res.headers.get("content-type") || "";
        if (!ctype.includes("text/event-stream")) continue;
        readOpencodeStream(entry, res.body).catch(() => {});
        return;
      } catch (err) {
        if (entry.controller.signal.aborted) return;
      }
    }
    console.warn(`[opencode] no event stream at ${base}; agent output will be partial`);
  })();

  return entry.ready;
}

async function readOpencodeStream(entry, body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        const type = data.type || "";
        const sessionId = sessionFromOpencodeEvent(data);
        if (!sessionId) continue;
        const targets = opencodeRuns(entry.base, sessionId);
        if (!targets.length) continue;

        if (type.endsWith("session.idle") || type === "session.idle") {
          for (const run of targets) finishRun(run.id, { type: "done", text: run.text });
          entry.lastText.delete(sessionId);
          continue;
        }
        if (type.endsWith("session.error") || type === "session.error") {
          const props = data.properties || data;
          const message =
            props.error?.message || props.error?.data?.message || props.message || "opencode session error";
          for (const run of targets) finishRun(run.id, { type: "error", error: { message } });
          continue;
        }

        const extracted = textFromOpencodeEvent(data);
        if (!extracted) continue;

        let chunk = extracted.text;
        if (extracted.mode === "cumulative") {
          const previous = entry.lastText.get(sessionId) || "";
          if (chunk.startsWith(previous)) chunk = chunk.slice(previous.length);
          else if (previous.startsWith(chunk)) chunk = "";
          entry.lastText.set(sessionId, extracted.text);
        }
        if (!chunk) continue;
        for (const run of targets) runEvent(run.id, { type: "chunk", text: chunk });
      }
    }
  } finally {
    entry.closed = true;
  }
}

async function startOpencodeRun(run) {
  const base = (run.target.url || OPENCODE_URL).replace(/\/+$/, "");
  run.base = base;
  try {
    if (!run.sessionId) {
      run.sessionId = await createOpencodeSession(base, run.controller.signal);
    }
    await ensureOpencodeStream(base);
    await new Promise((r) => setTimeout(r, 150));
    await sendOpencodePrompt(base, run.sessionId, run.target.prompt, run.controller.signal);
    runEvent(run.id, {
      type: "meta",
      adapter: "opencode",
      base,
      sessionId: run.sessionId,
    });
  } catch (err) {
    if (!runs.has(run.id)) return;
    finishRun(run.id, { type: "error", error: { message: err.message } });
  }
}

// ---------------------------------------------------------------------------
// LLM adapter (OpenAI-compatible /chat/completions)
// ---------------------------------------------------------------------------

function llmEndpoint() {
  if (!LLM_URL) return "";
  if (LLM_URL.endsWith("/chat/completions")) return LLM_URL;
  return `${LLM_URL}/chat/completions`;
}

async function streamLlm(messages, onText, signal) {
  const endpoint = llmEndpoint();
  if (!endpoint) throw new Error("LLM_URL is not configured on the hub");
  if (!LLM_MODEL) throw new Error("LLM_MODEL is not configured on the hub");
  const headers = { "content-type": "application/json" };
  if (LLM_KEY) headers.authorization = `Bearer ${LLM_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: LLM_MODEL, messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM endpoint ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const text = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text ?? "";
      if (text) {
        full += text;
        onText(text);
      }
    }
  }
  return full;
}

async function startLlmRun(run) {
  try {
    const full = await streamLlm(
      [
        {
          role: "system",
          content:
            "You are one participant in a multi-agent design review. Be concise, concrete and opinionated.",
        },
        { role: "user", content: run.target.prompt },
      ],
      (text) => runEvent(run.id, { type: "chunk", text }),
      run.controller.signal,
    );
    finishRun(run.id, { type: "done", text: full });
  } catch (err) {
    if (run.controller.signal.aborted) return;
    finishRun(run.id, { type: "error", error: { message: err.message } });
  }
}

// ---------------------------------------------------------------------------
// Adapter pack
// ---------------------------------------------------------------------------

function adapterPackRecord() {
  let stat;
  try {
    stat = fs.statSync(ADAPTER_PACK_FILE);
  } catch (err) {
    adapterPackCache = { mtimeMs: 0, envelope: null, etag: null, error: err.code || err.message };
    return adapterPackCache;
  }
  if (adapterPackCache.mtimeMs === stat.mtimeMs) return adapterPackCache;
  try {
    const envelope = readPackFile(ADAPTER_PACK_FILE);
    adapterPackCache = {
      mtimeMs: stat.mtimeMs,
      envelope,
      etag: packEtag(envelope),
      error: null,
    };
  } catch (err) {
    adapterPackCache = { mtimeMs: stat.mtimeMs, envelope: null, etag: null, error: err.message };
  }
  return adapterPackCache;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function originAllowed(origin) {
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return local && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === PORT;
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "content-type,authorization");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "origin");
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    return json(res, 403, { ok: false, error: "origin not allowed" });
  }
  const needsJson =
    url.pathname === "/api/runs" ||
    url.pathname === "/api/llm" ||
    url.pathname === "/api/plan" ||
    url.pathname === "/api/kev/rerank";
  if (needsJson && req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) {
    return json(res, 415, { ok: false, error: "content-type must be application/json" });
  }

  const pathname = url.pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round(process.uptime()),
      opencode: true,
      opencodeUrl: OPENCODE_URL,
      llm: !!(LLM_URL && LLM_MODEL),
      llmModel: LLM_MODEL || null,
      kev: kev.enabled,
      kevModel: kev.enabled ? kev.model : null,
      audit: audit.enabled,
      adapterPack: packSummary(adapterPackRecord().envelope),
      extensionClients: extClients.size,
      tabs: aggregateTabs().length,
      runs: runs.size,
    });
  }

  if (pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, {
      hub: true,
      version: VERSION,
      opencodeUrl: OPENCODE_URL,
      llmConfigured: !!(LLM_URL && LLM_MODEL),
      kevConfigured: kev.enabled,
      adapterPackConfigured: !!adapterPackRecord().envelope,
      adapterPackVersion: adapterPackRecord().envelope?.payload?.version || null,
      extensionTokenHint: TOKEN.slice(0, 4) + "…",
    });
  }

  if ((pathname === "/api/adapter-pack" || pathname === "/api/adapter-pack/update") && req.method === "GET") {
    const record = adapterPackRecord();
    if (!record.envelope) {
      return json(res, 404, { ok: false, error: "adapter pack unavailable", detail: record.error });
    }
    const currentVersion = Math.max(0, Number(url.searchParams.get("version")) || 0);
    const version = record.envelope.payload?.version || 0;
    const headers = {
      etag: record.etag,
      "cache-control": "no-cache",
      "x-melon-adapter-pack-version": String(version),
      "x-melon-adapter-pack-sha256": record.envelope.sha256 || "",
    };
    if (
      req.headers["if-none-match"] === record.etag ||
      (pathname.endsWith("/update") && currentVersion > 0 && currentVersion >= version)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const text = JSON.stringify(record.envelope);
    res.writeHead(200, {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
    return;
  }

  if (pathname === "/api/adapter-pack/pubkey" && req.method === "GET") {
    try {
      const record = readPackFile(ADAPTER_PACK_PUB_FILE);
      return json(res, 200, record);
    } catch (err) {
      return json(res, 404, { ok: false, error: "adapter pack public key unavailable", detail: err.code || err.message });
    }
  }

  if (pathname === "/api/tabs" && req.method === "GET") {
    return json(res, 200, { tabs: aggregateTabs() });
  }

  if (pathname === "/api/plan" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    const goal = String(body.goal || "").trim();
    if (!goal) return json(res, 400, { ok: false, error: "goal is required" });
    if (goal.length > 8000) return json(res, 400, { ok: false, error: "goal is too long" });
    const candidateCount = Math.max(1, Math.min(4, Number(body.candidates) || 1));
    let texts;
    try {
      ({ texts } = await requestPlan(goal, candidateCount));
    } catch (err) {
      return json(res, 503, { ok: false, error: err.message });
    }

    const valid = [];
    const invalid = [];
    for (const [index, text] of texts.entries()) {
      let parsed;
      try {
        parsed = extractJsonObject(text);
      } catch (err) {
        invalid.push({ candidate: index + 1, error: err.message, raw: text.slice(0, 1200) });
        continue;
      }
      const plan = validatePlanGraph(parsed, { goal });
      if (plan.ok) valid.push({ graph: plan.graph, warnings: plan.warnings, text });
      else invalid.push({ candidate: index + 1, error: "invalid graph", errors: plan.errors, raw: text.slice(0, 1200) });
    }

    if (!valid.length) {
      const errors = invalid.flatMap((item) =>
        item.errors?.length
          ? item.errors.map((error) => `candidate ${item.candidate}: ${error}`)
          : [`candidate ${item.candidate}: ${item.error}`]
      );
      return json(res, 422, {
        ok: false,
        error: "model returned no valid graph",
        errors,
        raw: invalid[0]?.raw || texts[0]?.slice(0, 4000) || "",
      });
    }

    const chosen = await choosePlan(goal, valid);
    return json(res, 200, {
      ok: true,
      graph: chosen.plan.graph,
      warnings: chosen.plan.warnings,
      candidates: valid.length,
      rejected: invalid.length,
      reranked: chosen.reranked,
      rerank: chosen.rerank
        ? {
            model: chosen.rerank.model,
            confidence: chosen.rerank.confidence,
            scores: chosen.rerank.scores,
          }
        : null,
      ...(chosen.rerankError ? { rerankError: chosen.rerankError } : {}),
    });
  }

  if (pathname === "/api/kev/rerank" && req.method === "POST") {
    if (!kev.enabled) {
      return json(res, 503, { ok: false, error: "Kev is not configured. Set KEV_URL on the hub." });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    try {
      const result = await kev.rerank(body.query, body.candidates, {
        topK: body.topK,
        instructions: body.instructions,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, err.status || 502, { ok: false, error: err.message });
    }
  }

  if (pathname === "/api/runs" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    const runId = String(body.runId || "");
    const target = body.target || {};
    if (!runId) return json(res, 400, { ok: false, error: "runId is required" });
    if (!["extension", "opencode", "llm"].includes(target.type)) {
      return json(res, 400, { ok: false, error: "target.type must be extension, opencode or llm" });
    }
    const prompt = String(body.prompt || "");
    if (!prompt.trim()) return json(res, 400, { ok: false, error: "prompt is required" });
    if (runs.has(runId)) return json(res, 409, { ok: false, error: "runId already exists" });
    target.prompt = prompt;
    target.adapter = target.adapter || "auto";
    target.retrievePageContext = !!target.retrievePageContext;

    const run = newRun(runId, target);
    json(res, 202, { ok: true, runId });
    if (target.type === "extension") startExtensionRun(run);
    else if (target.type === "opencode") startOpencodeRun(run);
    else startLlmRun(run);
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const ok = abortRun(decodeURIComponent(cancelMatch[1]));
    return json(res, ok ? 200 : 404, { ok });
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": melon hub\n\n");
    sseClients.add(res);
    sseSend(res, {
      type: "hello",
      version: VERSION,
      llm: !!(LLM_URL && LLM_MODEL),
      kev: kev.enabled,
      opencodeUrl: OPENCODE_URL,
      tabs: aggregateTabs(),
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 20000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname === "/api/llm" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    if (!LLM_URL || !LLM_MODEL) {
      return json(res, 503, {
        ok: false,
        error: "Hub LLM is not configured. Set LLM_URL and LLM_MODEL before starting the hub.",
      });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return json(res, 400, { ok: false, error: "messages is required" });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    try {
      await streamLlm(messages, (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`));
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
    return;
  }

  return json(res, 404, { ok: false, error: "not found" });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(WEB, "." + pathname);
  if (!filePath.startsWith(WEB + path.sep) && filePath !== path.join(WEB, "index.html")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": ext === ".wasm" ? "public, max-age=3600" : "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error("[hub] request failed", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/extension") {
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const supplied = url.searchParams.get("token") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  const client = {
    socket,
    buffer: Buffer.alloc(0),
    fragment: "",
    tabs: [],
    name: "extension",
    connectedAt: Date.now(),
  };
  extClients.add(client);
  socket.on("data", (chunk) => parseFrames(client, chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    extClients.delete(client);
    for (const [id, plan] of [...plans.entries()]) {
      if (plan.client !== client) continue;
      clearTimeout(plan.timer);
      plans.delete(id);
      plan.reject(new Error("extension disconnected"));
    }
    for (const [id, run] of [...runs.entries()]) {
      if (
        run.target.type === "extension" &&
        client.tabs.some((t) => String(t.id) === String(run.target.tabId))
      ) {
        finishRun(id, { type: "error", error: { message: "extension disconnected" } });
      }
    }
    broadcastTabs();
  });
  if (head?.length) parseFrames(client, head);
  sendWs(client, { type: "hello", version: VERSION, name: "melon-hub" });
  console.log(
    `[hub] extension connected (${extClients.size} client${extClients.size === 1 ? "" : "s"})`,
  );
});

setInterval(() => {
  for (const client of extClients) sendWs(client, { type: "ping", t: Date.now() });
}, 25000).unref();

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log("");
  console.log("  MELON agentic office");
  console.log(`  canvas      ${base}/`);
  console.log(`  hub health  ${base}/api/health`);
  console.log(`  opencode    ${OPENCODE_URL}`);
  console.log(`  llm         ${LLM_URL && LLM_MODEL ? `${LLM_MODEL} @ ${LLM_URL}` : "not configured"}`);
  console.log(`  kev         ${kev.enabled ? `${kev.model} @ ${kev.endpoint}` : "not configured (set KEV_URL)"}`);
  console.log(`  audit       ${audit.enabled ? audit.file : "off (set MELON_AUDIT=1 or MELON_AUDIT_LOG)"}`);
  console.log("");
  console.log("  extension token (paste into the extension options page):");
  console.log(`  ${TOKEN}`);
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n[hub] shutting down");
  for (const res of sseClients) res.end();
  for (const client of extClients) client.socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});

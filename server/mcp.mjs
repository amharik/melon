// Minimal Model Context Protocol (MCP) stdio client and server.
//
// The client spawns a local MCP server with piped stdio and performs the
// initialize -> tools/list -> tools/call handshake. The server exposes a small
// read-only view of the Melon hub so external agents can discover tabs and
// search local messages without opening a new listening port.

import { spawn } from "node:child_process";
import readline from "node:readline";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-06-18", "2024-11-05"]);
const DEFAULT_TIMEOUT_MS = 30000;

export const MCP_TOOLS = [
  {
    name: "melon_health",
    description: "Return Melon hub health, configured adapters, and message store status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "melon_list_tabs",
    description: "List browser tabs currently bridged by the Melon extension.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "melon_search_messages",
    description: "Search persisted team-chat messages with hybrid FTS5 and vector ranking.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query" },
        targetType: { type: "string", description: "Optional channel or dm filter" },
        targetId: { type: "string", description: "Optional target id filter" },
        topK: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "melon_append_message",
    description: "Append a message to the local SQLite team-chat store.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        targetType: { type: "string", default: "channel" },
        targetId: { type: "string", default: "general-war-room" },
        author: { type: "string" },
        tag: { type: "string" },
        isUser: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return {
    content: [{ type: "text", text: String(error?.message || error) }],
    isError: true,
  };
}

export function createMcpServer({
  hubUrl = "http://127.0.0.1:8787",
  fetchImpl = fetch,
  version = "0.1.0",
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = String(hubUrl || "").replace(/\/+$/, "");

  async function hubRequest(pathname, { method = "GET", body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        throw new Error(data?.error || `Melon hub ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callTool(name, args = {}) {
    try {
      if (name === "melon_health") return toolResult(await hubRequest("/api/health"));
      if (name === "melon_list_tabs") return toolResult(await hubRequest("/api/tabs"));
      if (name === "melon_search_messages") {
        const query = String(args.q || "").trim();
        if (!query) throw new Error("q is required");
        const params = new URLSearchParams({ q: query });
        if (args.targetType) params.set("targetType", String(args.targetType));
        if (args.targetId) params.set("targetId", String(args.targetId));
        if (args.topK) params.set("topK", String(args.topK));
        return toolResult(await hubRequest(`/api/messages/search?${params}`));
      }
      if (name === "melon_append_message") {
        const text = String(args.text || "");
        if (!text.trim()) throw new Error("text is required");
        return toolResult(
          await hubRequest("/api/messages", {
            method: "POST",
            body: {
              text,
              targetType: args.targetType || undefined,
              targetId: args.targetId || undefined,
              author: args.author || undefined,
              tag: args.tag || undefined,
              isUser: typeof args.isUser === "boolean" ? args.isUser : undefined,
            },
          }),
        );
      }
      throw new Error(`unknown tool: ${name}`);
    } catch (err) {
      return toolError(err);
    }
  }

  async function handle(message) {
    if (!message || typeof message !== "object") return null;
    const hasId = message.id !== undefined && message.id !== null;
    const reply = (result) => (hasId ? { jsonrpc: "2.0", id: message.id, result } : null);
    const fail = (code, text) =>
      hasId ? { jsonrpc: "2.0", id: message.id, error: { code, message: text } } : null;

    if (message.method === "initialize") {
      const requested = String(message.params?.protocolVersion || "");
      const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "melon-hub", version },
      });
    }
    if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
      return null;
    }
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") return reply({ tools: MCP_TOOLS });
    if (message.method === "tools/call") {
      const name = String(message.params?.name || "");
      const args = message.params?.arguments && typeof message.params.arguments === "object"
        ? message.params.arguments
        : {};
      return reply(await callTool(name, args));
    }
    if (message.method === "shutdown") return reply({});
    return fail(-32601, `method not found: ${message.method}`);
  }

  return { handle, callTool, tools: MCP_TOOLS, hubUrl: base };
}

export function serveMcpStdio(server, { input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    try {
      const response = await server.handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      error.write(`[melon-mcp] ${err?.stack || err}\n`);
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32603, message: String(err?.message || err) },
        })}\n`,
      );
    }
  });
  return lines;
}

export function createMcpClient({
  command = "",
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onNotification = null,
} = {}) {
  let child = null;
  let lines = null;
  let nextId = 1;
  let stderr = "";
  let initialized = null;
  const pending = new Map();

  function rejectAll(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function start() {
    if (child) return child;
    if (!command) throw new Error("MCP command is not configured");
    child = spawn(command, Array.isArray(args) ? args : [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    stderr = "";
    child.stderr.on("data", (buffer) => {
      stderr = `${stderr}${buffer.toString()}`.slice(-4000);
    });
    child.on("error", (err) => {
      rejectAll(err);
      child = null;
    });
    child.on("exit", (code, signal) => {
      rejectAll(new Error(`MCP server exited (${signal || code})${stderr ? `: ${stderr.slice(-1000)}` : ""}`));
      child = null;
      lines?.close();
      lines = null;
    });
    lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message || "MCP request failed"));
        else item.resolve(message.result);
        return;
      }
      if (message.method && typeof onNotification === "function") onNotification(message);
    });
    return child;
  }

  function send(message) {
    const proc = start();
    if (!proc?.stdin?.writable) throw new Error("MCP server stdin is not writable");
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}, { requestTimeoutMs = timeoutMs } = {}) {
    start();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, Math.max(1000, Number(requestTimeoutMs) || timeoutMs));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function initialize() {
    const result = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "melon-hub", version: "0.1.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  function ensureInitialized() {
    if (!initialized) initialized = initialize();
    return initialized;
  }

  async function listTools() {
    await ensureInitialized();
    return request("tools/list", {});
  }

  async function callTool(name, toolArgs = {}) {
    await ensureInitialized();
    return request("tools/call", { name, arguments: toolArgs });
  }

  function close() {
    rejectAll(new Error("MCP client closed"));
    try {
      lines?.close();
    } catch {}
    lines = null;
    try {
      child?.kill("SIGTERM");
    } catch {}
    child = null;
    initialized = null;
  }

  return { initialize: ensureInitialized, listTools, callTool, request, close, enabled: !!command };
}

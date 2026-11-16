import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpClient, createMcpServer, serveMcpStdio } from "../server/mcp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "test", "fixtures", "mcp-server.mjs");

test("MCP client initializes, lists tools, and calls a tool over stdio", async () => {
  const client = createMcpClient({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    timeoutMs: 5000,
  });
  const init = await client.initialize();
  assert.equal(init.protocolVersion, "2026-07-28");
  const list = await client.listTools();
  assert.equal(list.tools[0].name, "echo");
  const result = await client.callTool("echo", { text: "hello" });
  assert.equal(result.content[0].text, "echo: hello");
  client.close();
});

test("MCP server maps tools onto hub HTTP endpoints", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, url });
      },
    };
  };
  const server = createMcpServer({ hubUrl: "http://127.0.0.1:8787/", fetchImpl });
  const init = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "melon-hub");

  const list = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.some((tool) => tool.name === "melon_search_messages"));

  const search = await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "melon_search_messages", arguments: { q: "vector search", topK: 5 } },
  });
  assert.equal(search.result.isError, undefined);
  assert.ok(requests[0].url.startsWith("http://127.0.0.1:8787/api/messages/search?"));
  assert.match(requests[0].url, /q=vector\+search/);
  assert.match(requests[0].url, /topK=5/);

  const appended = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "melon_append_message", arguments: { text: "hello", targetId: "general" } },
  });
  assert.equal(appended.result.isError, undefined);
  assert.equal(requests[1].url, "http://127.0.0.1:8787/api/messages");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(JSON.parse(requests[1].options.body).text, "hello");
});

test("MCP stdio server replies to JSON-RPC lines", async () => {
  const server = createMcpServer({
    hubUrl: "http://127.0.0.1:8787",
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  serveMcpStdio(server, { input, output, error: errors });

  let buffer = "";
  const lines = [];
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  const started = Date.now();
  while (lines.length < 2 && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, "melon-hub");
  assert.ok(Array.isArray(lines[1].result.tools));
  input.end();
  output.end();
  errors.end();
});

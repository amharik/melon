import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-melon";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(40);
  }
  throw new Error("timed out waiting for condition");
}

function sseQueue(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            events.push(JSON.parse(line.slice(5)));
          }
        }
      }
    } catch {}
  })();
  return {
    events,
    next(predicate, timeout = 5000) {
      return waitFor(() => {
        const index = events.findIndex(predicate);
        if (index < 0) return null;
        return events.splice(index, 1)[0];
      }, timeout);
    },
    close() {
      reader.cancel().catch(() => {});
      return pump.catch(() => {});
    },
  };
}

function waitForMessage(messages, predicate, timeout = 5000) {
  return waitFor(() => {
    const index = messages.findIndex(predicate);
    if (index < 0) return null;
    return messages.splice(index, 1)[0];
  }, timeout);
}

test("hub serves the app, enforces CORS, and brokers extension runs", async (t) => {
  const kevPort = await freePort();
  const kevServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "kev",
        answers: {
          rank: {
            type: "choice",
            choice: "c1",
            confidence: 0.81,
            probabilities: { c0: 0.08, c1: 0.81, c2: 0.11 },
          },
        },
        usage: { input_tokens: 24, output_tokens: 1 },
      })
    );
  });
  await new Promise((resolve) => kevServer.listen(kevPort, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => kevServer.close(resolve)));

  const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-hub-audit-"));
  const auditFile = path.join(auditDir, "audit.jsonl");
  t.after(() => fs.rm(auditDir, { recursive: true, force: true }));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/hub.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MELON_TOKEN: TOKEN,
      OPENCODE_URL: "http://127.0.0.1:1",
      KEV_URL: `http://127.0.0.1:${kevPort}`,
      KEV_MODEL: "kev",
      MELON_AUDIT_LOG: auditFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (data) => (logs += data));
  child.stderr.on("data", (data) => (logs += data));

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitFor(async () => {
    const response = await fetch(`${base}/api/health`);
    return response.ok;
  });

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, "0.1.0");
  assert.equal(health.kev, true);
  assert.equal(health.kevModel, "kev");
  assert.equal(health.audit, true);
  assert.equal(health.adapterPack.version, 2);
  assert.equal(health.adapterPack.keyId, "melon-dev");

  const packResponse = await fetch(`${base}/api/adapter-pack/update?version=1`);
  assert.equal(packResponse.status, 200);
  assert.equal(packResponse.headers.get("x-melon-adapter-pack-version"), "2");
  assert.match(packResponse.headers.get("etag"), /^"sha256-[a-f0-9]{64}"$/);
  const pack = await packResponse.json();
  assert.equal(pack.payload.version, 2);
  assert.equal(pack.keyId, "melon-dev");

  const currentResponse = await fetch(`${base}/api/adapter-pack/update?version=2`);
  assert.equal(currentResponse.status, 304);
  const cachedResponse = await fetch(`${base}/api/adapter-pack`, {
    headers: { "if-none-match": packResponse.headers.get("etag") },
  });
  assert.equal(cachedResponse.status, 304);

  const pubkey = await (await fetch(`${base}/api/adapter-pack/pubkey`)).json();
  assert.equal(pubkey.keyId, "melon-dev");
  assert.ok(pubkey.publicKey.length > 20);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /agentic office/i);

  const wasm = await fetch(`${base}/wasm/melon_core.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");

  const evil = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const local = await fetch(`${base}/api/health`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(local.headers.get("access-control-allow-origin"), `http://127.0.0.1:${port}`);

  const csrf = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({
      runId: "csrf",
      prompt: "drive-by",
      target: { type: "extension", tabId: 42, node: "reviewer", label: "Reviewer" },
    }),
  });
  assert.equal(csrf.status, 403);

  const simplePost = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({
      runId: "simple",
      prompt: "drive-by",
      target: { type: "extension", tabId: 42, node: "reviewer", label: "Reviewer" },
    }),
  });
  assert.equal(simplePost.status, 415);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).runs, 0);

  const sse = sseQueue(await fetch(`${base}/api/events`));
  t.after(() => sse.close());
  await sse.next((event) => event.type === "hello");

  const bad = new WebSocket(`ws://127.0.0.1:${port}/extension?token=wrong`);
  const badResult = await new Promise((resolve) => {
    bad.onopen = () => resolve("open");
    bad.onerror = () => resolve("error");
    bad.onclose = () => resolve("close");
    setTimeout(() => resolve("timeout"), 1500);
  });
  assert.notEqual(badResult, "open");

  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`);
  const messages = [];
  ws.onmessage = (event) => messages.push(JSON.parse(event.data));
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  assert.equal((await waitForMessage(messages, (m) => m.type === "hello")).type, "hello");
  ws.send(
    JSON.stringify({
      type: "hello",
      name: "test",
      tabs: [
        {
          id: 42,
          controlId: "T-16",
          title: "Claude tab",
          url: "https://claude.ai/",
          attached: true,
          supported: true,
          adapter: "claude",
          schemaVersion: 1,
          health: { ok: true, fields: { composer: { ok: true }, send: { ok: true } } },
          healthError: null,
          busy: false,
          checkedAt: 123,
        },
      ],
    })
  );
  await sse.next((event) => event.type === "tabs");

  const tabs = await (await fetch(`${base}/api/tabs`)).json();
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0].id, 42);
  assert.equal(tabs.tabs[0].controlId, "T-16");
  assert.equal(tabs.tabs[0].adapter, "claude");
  assert.equal(tabs.tabs[0].health.ok, true);
  assert.equal(tabs.tabs[0].healthError, null);
  assert.equal(tabs.tabs[0].busy, false);
  assert.equal(tabs.tabs[0].checkedAt, 123);

  const planResponse = fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "review the launch plan" }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const planRequest = await waitForMessage(messages, (m) => m.type === "agent.plan");
  assert.equal(planRequest.goal, "review the launch plan");
  ws.send(
    JSON.stringify({
      type: "plan.result",
      requestId: planRequest.requestId,
      ok: true,
      text: JSON.stringify({
        nodes: [
          { id: "brief", kind: "source", config: { topic: "review the launch plan" } },
          { id: "reviewer", kind: "agent", config: { adapter: "claude" } },
          { id: "decision", kind: "sink" },
        ],
        edges: [
          { from: { node: "brief", port: "out" }, to: { node: "reviewer", port: "in" } },
          { from: { node: "reviewer", port: "result" }, to: { node: "decision", port: "in" } },
        ],
      }),
    })
  );
  const planned = await planResponse;
  assert.equal(planned.status, 200);
  assert.equal(planned.body.ok, true);
  assert.equal(planned.body.graph.nodes[1].config.adapter, "demo:claude");
  assert.equal(planned.body.graph.edges.length, 2);

  const badPlanResponse = fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "bad plan" }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const badPlanRequest = await waitForMessage(messages, (m) => m.type === "agent.plan");
  ws.send(
    JSON.stringify({
      type: "plan.result",
      requestId: badPlanRequest.requestId,
      ok: true,
      text: "not json",
    })
  );
  const badPlan = await badPlanResponse;
  assert.equal(badPlan.status, 422);
  assert.equal(badPlan.body.ok, false);

  const plainPlan = await fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ goal: "no json content type" }),
  });
  assert.equal(plainPlan.status, 415);

  const rerank = await fetch(`${base}/api/kev/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "best plan",
      candidates: [
        { id: "a", text: "plan a" },
        { id: "b", text: "plan b" },
        { id: "c", text: "plan c" },
      ],
      topK: 2,
    }),
  });
  const reranked = await rerank.json();
  assert.equal(rerank.status, 200);
  assert.equal(reranked.ok, true);
  assert.deepEqual(reranked.ranked, ["b", "c", "a"]);
  assert.deepEqual(reranked.selected, ["b", "c"]);

  const multiPlanResponse = fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "compare two plans", candidates: 2 }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const multiPlanRequest = await waitForMessage(messages, (m) => m.type === "agent.plan");
  assert.equal(multiPlanRequest.candidates, 2);
  const candidate = (label) => ({
    nodes: [
      { id: "brief", kind: "source", label, config: { topic: "compare two plans" } },
      { id: "reviewer", kind: "agent", config: { adapter: "claude" } },
      { id: "decision", kind: "sink" },
    ],
    edges: [
      { from: { node: "brief", port: "out" }, to: { node: "reviewer", port: "in" } },
      { from: { node: "reviewer", port: "result" }, to: { node: "decision", port: "in" } },
    ],
  });
  ws.send(
    JSON.stringify({
      type: "plan.result",
      requestId: multiPlanRequest.requestId,
      ok: true,
      texts: [JSON.stringify(candidate("First")), JSON.stringify(candidate("Second"))],
    })
  );
  const multiPlan = await multiPlanResponse;
  assert.equal(multiPlan.status, 200);
  assert.equal(multiPlan.body.ok, true);
  assert.equal(multiPlan.body.candidates, 2);
  assert.equal(multiPlan.body.reranked, true);
  assert.equal(multiPlan.body.graph.nodes[0].label, "Second");

  const start = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "run-1",
      prompt: "review the proposal",
      target: { type: "extension", tabId: 42, node: "reviewer", label: "Reviewer" },
    }),
  });
  assert.equal(start.status, 202);

  const agentRun = await waitForMessage(messages, (m) => m.type === "agent.run");
  assert.equal(agentRun.runId, "run-1");
  assert.equal(agentRun.prompt, "review the proposal");

  ws.send(JSON.stringify({ type: "run.event", runId: "run-1", event: { type: "chunk", text: "hello " } }));
  ws.send(JSON.stringify({ type: "run.event", runId: "run-1", event: { type: "done", text: "hello world" } }));

  const chunk = await sse.next((event) => event.type === "run.event" && event.event?.type === "chunk");
  assert.equal(chunk.event.text, "hello ");
  const done = await sse.next((event) => event.type === "run.event" && event.event?.type === "done");
  assert.equal(done.event.text, "hello world");

  const auditEvents = await waitFor(async () => {
    try {
      const lines = (await fs.readFile(auditFile, "utf8")).trim().split("\n").filter(Boolean);
      return lines.length >= 2 ? lines.map((line) => JSON.parse(line)) : null;
    } catch {
      return null;
    }
  });
  const auditStart = auditEvents.find((event) => event.event === "run.start" && event.runId === "run-1");
  const auditEnd = auditEvents.find((event) => event.event === "run.end" && event.runId === "run-1");
  assert.equal(auditStart.controlId, "T-16");
  assert.equal(auditStart.adapter, "auto");
  assert.equal(auditStart.node, "reviewer");
  assert.equal(auditEnd.status, "done");
  assert.equal(auditEnd.chars, 11);
  const auditRaw = await fs.readFile(auditFile, "utf8");
  assert.equal(auditRaw.includes("review the proposal"), false);
  assert.equal(auditRaw.includes("hello world"), false);

  const start2 = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: "run-2", prompt: "cancel me", target: { type: "extension", tabId: 42 } }),
  });
  assert.equal(start2.status, 202);
  await waitForMessage(messages, (m) => m.type === "agent.run" && m.runId === "run-2");
  const cancel = await fetch(`${base}/api/runs/run-2/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);
  await waitForMessage(messages, (m) => m.type === "cancel" && m.runId === "run-2");
  const cancelled = await sse.next(
    (event) => event.type === "run.event" && event.runId === "run-2" && event.event?.type === "cancelled"
  );
  assert.equal(cancelled.event.type, "cancelled");

  if (logs.includes("UnhandledPromiseRejection")) {
    assert.fail(logs);
  }
});

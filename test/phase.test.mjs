import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "phase-test-token";
const FAKE_AGY = path.join(ROOT, "scripts", "fake-agy.mjs");
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

async function waitFor(fn, timeout = 6000) {
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
    next(predicate, timeout = 6000) {
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

function waitForMessage(messages, predicate, timeout = 6000) {
  return waitFor(() => {
    const index = messages.findIndex(predicate);
    if (index < 0) return null;
    return messages.splice(index, 1)[0];
  }, timeout);
}

test("phase 0-3: threads, agy, approvals, worktrees, blackboard, screenshots", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-phase-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worktreeRoot = path.join(dir, "worktrees");
  const blackboardFile = path.join(dir, "blackboard.md");
  await fs.writeFile(blackboardFile, "# Shared board\n\nUse ACP at the edge.\n");

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
      AGY_CMD: process.execPath,
      AGY_ARGS: FAKE_AGY,
      MELON_WORKTREE_ROOT: worktreeRoot,
      MELON_BLACKBOARD: blackboardFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (data) => (logs += data));
  child.stderr.on("data", (data) => (logs += data));
  t.after(() => child.kill("SIGTERM"));

  await waitFor(async () => (await fetch(`${base}/api/health`)).ok);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.agy, true);
  assert.equal(path.resolve(health.worktreeRoot), path.resolve(worktreeRoot));
  assert.equal(health.blackboard, true);

  const board = await (await fetch(`${base}/api/blackboard`)).json();
  assert.equal(board.ok, true);
  assert.match(board.text, /Shared board/);

  const sse = sseQueue(await fetch(`${base}/api/events`));
  t.after(() => sse.close());
  await sse.next((event) => event.type === "hello");

  const start = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: "agy-1",
      threadId: "thread-1",
      prompt: "review the plan",
      target: { type: "agy", node: "agy", label: "AGY" },
    }),
  });
  assert.equal(start.status, 202);
  assert.equal((await start.json()).threadId, "thread-1");

  assert.equal((await sse.next((event) => event.type === "run.status" && event.status === "thinking")).status, "thinking");
  assert.equal((await sse.next((event) => event.type === "run.status" && event.status === "streaming")).status, "streaming");
  const doneStatus = await sse.next((event) => event.type === "run.status" && event.status === "done");
  assert.equal(doneStatus.status, "done");
  const done = await sse.next(
    (event) => event.type === "run.event" && event.runId === "agy-1" && event.event?.type === "done",
  );
  assert.equal(done.event.text, "agy: review the plan");

  const thread = await (await fetch(`${base}/api/threads/thread-1`)).json();
  assert.equal(thread.ok, true);
  assert.equal(thread.thread.messages.length, 2);
  assert.equal(thread.thread.messages[0].role, "user");
  assert.equal(thread.thread.messages[1].role, "assistant");
  assert.equal(thread.thread.messages[1].text, "agy: review the plan");
  assert.equal(thread.thread.status, "done");
  const threads = await (await fetch(`${base}/api/threads`)).json();
  assert.ok(threads.threads.some((item) => item.id === "thread-1"));

  const requestResponse = await fetch(`${base}/api/tool-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "printf hello", reason: "check" }),
  });
  assert.equal(requestResponse.status, 201);
  const request = (await requestResponse.json()).request;
  assert.equal(request.status, "pending");
  assert.equal(request.taint, "untrusted");
  assert.equal(path.resolve(request.cwd), path.resolve(worktreeRoot));
  assert.equal((await sse.next((event) => event.type === "tool.request" && event.request.id === request.id)).request.status, "pending");

  const approved = await fetch(`${base}/api/tool-requests/${request.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(approved.status, 200);
  const approvedBody = await approved.json();
  assert.equal(approvedBody.request.status, "done");
  assert.equal(approvedBody.request.exitCode, 0);
  assert.equal(approvedBody.request.output, "hello");
  const toolResult = await sse.next((event) => event.type === "tool.result" && event.request.id === request.id);
  assert.equal(toolResult.request.taint, "untrusted");

  const deniedRequest = await (await fetch(`${base}/api/tool-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "echo no" }),
  })).json();
  const denied = await fetch(`${base}/api/tool-requests/${deniedRequest.request.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "deny" }),
  });
  assert.equal((await denied.json()).request.status, "denied");

  const badWorktree = await fetch(`${base}/api/worktrees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "../escape" }),
  });
  assert.equal(badWorktree.status, 400);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`);
  const messages = [];
  ws.onmessage = (event) => messages.push(JSON.parse(event.data));
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  await waitForMessage(messages, (message) => message.type === "hello");
  ws.send(
    JSON.stringify({
      type: "hello",
      name: "phase-test",
      tabs: [
        {
          id: 77,
          controlId: "T-77",
          title: "Claude",
          url: "https://claude.ai/",
          supported: true,
          adapter: "claude",
        },
      ],
    }),
  );
  await sse.next((event) => event.type === "tabs");

  const shot = await fetch(`${base}/api/tabs/77/screenshot`, { method: "POST" });
  assert.equal(shot.status, 202);
  const shotMessage = await waitForMessage(messages, (message) => message.type === "agent.screenshot");
  assert.equal(shotMessage.tabId, "77");
  ws.send(JSON.stringify({ type: "screenshot.result", requestId: shotMessage.requestId, tabId: 77, ok: true }));
  const shotResult = await sse.next((event) => event.type === "screenshot.result" && event.requestId === shotMessage.requestId);
  assert.equal(shotResult.ok, true);

  ws.send(
    JSON.stringify({
      type: "tool.request",
      runId: "ext-run",
      tabId: 77,
      command: "echo from-extension",
      reason: "extension test",
    }),
  );
  const extRequest = await sse.next(
    (event) => event.type === "tool.request" && event.request.command === "echo from-extension",
  );
  assert.equal(extRequest.request.controlId, "T-77");
  assert.equal(extRequest.request.taint, "untrusted");

  const extDecision = await fetch(`${base}/api/tool-requests/${extRequest.request.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(extDecision.status, 200);
  const tabResult = await waitForMessage(messages, (message) => message.type === "agent.tool.result");
  assert.equal(tabResult.taint, "untrusted");
  assert.equal(tabResult.exitCode, 0);
  assert.match(tabResult.output, /from-extension/);

  if (logs.includes("UnhandledPromiseRejection")) {
    assert.fail(logs);
  }
});

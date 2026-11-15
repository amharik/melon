import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createMessageStore } from "../server/messages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("SQLite message store persists turns, erases back, and searches vectors", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-msg-test-"));
  const dbPath = path.join(tmpDir, "test_messages.db");

  const store = createMessageStore({ dbPath });

  // 1. Append messages
  const msg1 = store.appendMessage({
    id: "m1",
    targetType: "channel",
    targetId: "general-war-room",
    author: "Human",
    avatar: "👤",
    tag: "HUMAN",
    time: "10:00 AM",
    text: "Can we optimize the SQLite vector similarity search algorithm?",
    isUser: true,
    createdAt: 1000,
  });
  assert.equal(msg1.id, "m1");
  assert.equal(msg1.isUser, true);

  const msg2 = store.appendMessage({
    id: "m2",
    targetType: "channel",
    targetId: "general-war-room",
    author: "Sparky (CLAUDE)",
    avatar: "🤖",
    tag: "AGENT",
    time: "10:01 AM",
    text: "Yes, normalized term frequency vectors with cosine ranking work well zero-dependency.",
    isUser: false,
    createdAt: 2000,
  });

  const msg3 = store.appendMessage({
    id: "m3",
    targetType: "channel",
    targetId: "general-war-room",
    author: "Human",
    avatar: "👤",
    tag: "HUMAN",
    time: "10:02 AM",
    text: "Let's benchmark the latency now.",
    isUser: true,
    createdAt: 3000,
  });

  // 2. Retrieve messages
  const all = store.getMessages("channel", "general-war-room");
  assert.equal(all.length, 3);
  assert.equal(all[0].id, "m1"); // Chronological
  assert.equal(all[2].id, "m3");

  // 3. Vector search
  const searchResults = store.searchMessages("vector similarity search", { targetType: "channel", targetId: "general-war-room" });
  assert.ok(searchResults.length > 0);
  assert.equal(searchResults[0].id, "m1");

  // 4. Erase last 1 turn
  const eraseOne = store.eraseMessages("channel", "general-war-room", { count: 1 });
  assert.equal(eraseOne.erasedCount, 1);
  const remainingAfterOne = store.getMessages("channel", "general-war-room");
  assert.equal(remainingAfterOne.length, 2);
  assert.equal(remainingAfterOne[0].id, "m1");
  assert.equal(remainingAfterOne[1].id, "m2");

  // 5. Delete single message
  store.deleteSingleMessage("m2");
  const remainingAfterSingle = store.getMessages("channel", "general-war-room");
  assert.equal(remainingAfterSingle.length, 1);
  assert.equal(remainingAfterSingle[0].id, "m1");

  // 6. Erase all
  store.eraseMessages("channel", "general-war-room");
  const empty = store.getMessages("channel", "general-war-room");
  assert.equal(empty.length, 0);

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("Persistent agent tab association retains agent identity across reboots", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-agent-test-"));
  const dbPath = path.join(tmpDir, "test_agents.db");

  const store = createMessageStore({ dbPath });

  // 1. Save agent with bound URLs
  const saved = store.savePersistentAgent({
    handle: "sparky-claude",
    quirky: "sparky",
    category: "claude",
    role: "Staff Software Architect",
    persona: "Adversarial code reviewer and system designer.",
    avatar: "🤖",
    urls: ["https://claude.ai/chat/project-alpha", "https://claude.ai/new"],
    tabId: 104,
  });

  assert.equal(saved.handle, "sparky-claude");
  assert.equal(saved.urls.length, 2);

  // 2. Fetch persistent agents
  const agents = store.getPersistentAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].handle, "sparky-claude");

  // 3. Match tab after reboot (e.g. new Chrome tab ID 42 opening same URL)
  const matched = store.matchTabToPersistentAgent({
    id: 42,
    url: "https://claude.ai/chat/project-alpha",
    adapter: "claude",
  });

  assert.ok(matched);
  assert.equal(matched.handle, "sparky-claude");
  assert.equal(matched.lastTabId, 42);

  // 4. Advance context to a new URL while retaining agent identity
  matched.urls.push("https://claude.ai/chat/project-beta");
  store.savePersistentAgent(matched);

  const updatedAgents = store.getPersistentAgents();
  assert.equal(updatedAgents[0].urls.length, 3);
  assert.ok(updatedAgents[0].urls.includes("https://claude.ai/chat/project-beta"));

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("DOM and App expose Slack Erase-Back, Persistent URLs, and Experiments View", async () => {
  const html = await fs.readFile(path.join(ROOT, "web/index.html"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "web/app.js"), "utf8");

  // 1. Erase-back controls in HTML
  assert.match(html, /id="btn-chat-erase-menu"/, "Expected #btn-chat-erase-menu in index.html");
  assert.match(html, /id="erase-back-menu"/, "Expected #erase-back-menu in index.html");
  assert.match(html, /data-erase="5"/, "Expected data-erase='5' option in index.html");
  assert.match(html, /data-erase="20"/, "Expected data-erase='20' option in index.html");
  assert.match(html, /data-erase="all"/, "Expected data-erase='all' option in index.html");

  // 2. Experiments & Labs View in HTML
  assert.match(html, /id="experiments-view"/, "Expected #experiments-view in index.html");
  assert.match(html, /id="nav-item-experiments"/, "Expected #nav-item-experiments in index.html");
  assert.match(html, /data-exp-tab="office"/, "Expected office exp tab");
  assert.match(html, /data-exp-tab="canvas"/, "Expected canvas exp tab");
  assert.match(html, /data-exp-tab="tournament"/, "Expected tournament exp tab");
  assert.match(html, /data-exp-tab="tasks"/, "Expected tasks exp tab");
  assert.match(html, /data-exp-tab="guide"/, "Expected guide exp tab");

  // 3. App.js handlers
  assert.match(app, /function loadSlackMessages/);
  assert.match(app, /function persistSlackMessage/);
  assert.match(app, /function eraseSlackMessages/);
  assert.match(app, /function deleteSlackMessage/);
  assert.match(app, /function setupExperimentsNavigation/);
  assert.match(app, /function selectExperimentsView/);
  assert.match(app, /function switchExperimentTab/);
  assert.match(app, /function savePersistentAgentToServer/);
  assert.match(app, /profile-urls-section/);
});

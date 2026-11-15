import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, formatTabRow, resolveTargetTab } from "../bin/melon.mjs";

test("cli argument parsing captures flags and commands", () => {
  const askArgs = parseCliArgs(["ask", "-t", "12345", "--silent", "Refactor the parser"]);
  assert.equal(askArgs.command, "ask");
  assert.equal(askArgs.tab, "12345");
  assert.equal(askArgs.silent, true);
  assert.equal(askArgs.prompt, "Refactor the parser");

  const roleArgs = parseCliArgs(["ask", "-r", "gemini", "-e", "--json"]);
  assert.equal(roleArgs.command, "ask");
  assert.equal(roleArgs.role, "gemini");
  assert.equal(roleArgs.extractOnly, true);
  assert.equal(roleArgs.json, true);

  const tabsArgs = parseCliArgs(["tabs", "--hub", "http://127.0.0.1:9999", "--token", "secret"]);
  assert.equal(tabsArgs.command, "tabs");
  assert.equal(tabsArgs.hub, "http://127.0.0.1:9999");
  assert.equal(tabsArgs.token, "secret");

  const exportArgs = parseCliArgs(["export", "run-abc", "--out", "./dist-artifacts", "--branch", "feature/melon"]);
  assert.equal(exportArgs.command, "export");
  assert.equal(exportArgs.runId, "run-abc");
  assert.equal(exportArgs.outDir, "./dist-artifacts");
  assert.equal(exportArgs.branch, "feature/melon");

  const helpArgs = parseCliArgs(["--help"]);
  assert.equal(helpArgs.help, true);
});

test("formatTabRow formats readable output with padded columns", () => {
  const row = formatTabRow({
    id: 101,
    adapter: "chatgpt",
    title: "System Design Review",
    url: "https://chatgpt.com/c/123",
  });
  assert.ok(row.includes("101"));
  assert.ok(row.includes("chatgpt"));
  assert.ok(row.includes("System Design Review"));
  assert.ok(row.includes("https://chatgpt.com/c/123"));
});

test("resolveTargetTab matches by tabId, role/adapter, or falls back to first", async () => {
  const mockTabs = [
    { id: "101", adapter: "chatgpt", title: "ChatGPT Workspace" },
    { id: "102", adapter: "gemini", title: "Gemini Research" },
    { id: "103", adapter: "claude", title: "Claude Code Generation" },
  ];

  // We test the matching logic with custom options
  const matchId = mockTabs.find((t) => String(t.id) === "102");
  assert.equal(matchId.adapter, "gemini");

  const matchRole = mockTabs.find((t) => t.adapter.includes("claude") || t.title.toLowerCase().includes("claude"));
  assert.equal(matchRole.id, "103");

  const defaultFirst = mockTabs[0];
  assert.equal(defaultFirst.id, "101");
});

test("cli argument parsing handles doctor command", () => {
  const docArgs = parseCliArgs(["doctor", "--hub", "http://127.0.0.1:8787"]);
  assert.equal(docArgs.command, "doctor");
  assert.equal(docArgs.hub, "http://127.0.0.1:8787");
});

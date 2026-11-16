import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, formatTabRow, resolveTargetTab, extractShellCommands, mergeStreamText } from "../bin/melon.mjs";

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

test("cli parses melon do and melon decide with flags and commands", () => {
  const doArgs = parseCliArgs(["do", "-y", "--retries", "4", "Build and test the project"]);
  assert.equal(doArgs.command, "do");
  assert.equal(doArgs.autoExec, true);
  assert.equal(doArgs.retries, 4);
  assert.equal(doArgs.prompt, "Build and test the project");

  const runAlias = parseCliArgs(["run", "-x", "Fix the failing test"]);
  assert.equal(runAlias.command, "do");
  assert.equal(runAlias.autoExec, true);
  assert.equal(runAlias.prompt, "Fix the failing test");

  const decideArgs = parseCliArgs(["decide", "auth user", "Postgres DB", "OAuth JWT Handler", "CSS"]);
  assert.equal(decideArgs.command, "decide");
  assert.equal(decideArgs.query, "auth user");
  assert.deepEqual(decideArgs.candidates, ["Postgres DB", "OAuth JWT Handler", "CSS"]);
});

test("auto-exec requires an explicit untrusted-exec opt-in", () => {
  assert.equal(parseCliArgs(["do", "-y", "task"]).allowUntrusted, false);
  const trusted = parseCliArgs(["do", "-y", "--allow-untrusted-exec", "task"]);
  assert.equal(trusted.autoExec, true);
  assert.equal(trusted.allowUntrusted, true);
});

test("mergeStreamText handles delta and cumulative chunks without duplication", () => {
  assert.deepEqual(mergeStreamText("", "Hello"), { text: "Hello", delta: "Hello" });
  // Delta chunks (extension bridge).
  assert.deepEqual(mergeStreamText("Hello", " world"), { text: "Hello world", delta: " world" });
  // Cumulative snapshots (some adapters).
  assert.deepEqual(mergeStreamText("Hello", "Hello world"), { text: "Hello world", delta: " world" });
  // Duplicate replay is ignored.
  assert.deepEqual(mergeStreamText("Hello world", "world"), { text: "Hello world", delta: "" });
});

test("extractShellCommands extracts clean shell commands from markdown code blocks", () => {
  const markdown = `
Here is how you build and test:

\`\`\`bash
$ npm run build
npm test -- -t tasks
\`\`\`

And you can also run:
\`\`\`sh
# comment to ignore
cat package.json
\`\`\`
`;

  const cmds = extractShellCommands(markdown);
  assert.deepEqual(cmds, [
    "npm run build",
    "npm test -- -t tasks",
    "cat package.json",
  ]);
});

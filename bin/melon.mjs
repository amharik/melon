#!/usr/bin/env node
// Melon CLI: Reverse CLI-to-Web Oracle & Hub Controller.
//
// Zero-dependency binary to query active browser tabs (ChatGPT, Claude, Gemini, etc.),
// stream frontier reasoning directly into terminal pipelines, list bridged tabs,
// and export code artifacts into your project workspace.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";

// Find token file in current or parent directory
function findToken() {
  if (process.env.MELON_TOKEN) return process.env.MELON_TOKEN.trim();
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, ".melon-token");
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8").trim();
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function getHubUrl(argvHub) {
  let hub = argvHub || process.env.MELON_HUB_URL || "http://127.0.0.1:8787";
  return hub.replace(/\/+$/, "");
}

function parseCliArgs(args) {
  const parsed = {
    command: "help",
    prompt: "",
    tab: null,
    role: null,
    adapter: null,
    hub: null,
    token: null,
    json: false,
    silent: false,
    extractOnly: false,
    outDir: null,
    branch: null,
    help: false,
    version: false,
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--silent" || arg === "-s") {
      parsed.silent = true;
    } else if (arg === "--extract" || arg === "-e") {
      parsed.extractOnly = true;
    } else if (arg === "--tab" || arg === "-t") {
      parsed.tab = args[++i];
    } else if (arg === "--role" || arg === "-r") {
      parsed.role = args[++i];
    } else if (arg === "--adapter" || arg === "-a") {
      parsed.adapter = args[++i];
    } else if (arg === "--hub") {
      parsed.hub = args[++i];
    } else if (arg === "--token") {
      parsed.token = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      parsed.outDir = args[++i];
    } else if (arg === "--branch" || arg === "-b") {
      parsed.branch = args[++i];
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    parsed.command = positional[0];
    if (parsed.command === "ask") {
      parsed.prompt = positional.slice(1).join(" ");
    } else if (parsed.command === "export") {
      parsed.runId = positional[1] || "";
    }
  } else if (!parsed.help && !parsed.version) {
    parsed.command = "help";
  }

  return parsed;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

async function requestJson(url, options = {}) {
  const token = options.token || findToken();
  const headers = {
    accept: "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let errMsg = `HTTP ${res.status}: ${res.statusText}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  return res.json();
}

// Format tab line
function formatTabRow(tab) {
  const id = String(tab.id || "").padEnd(12);
  const adapter = String(tab.adapter || "auto").padEnd(12);
  const title = (tab.title || "Untitled").slice(0, 45).padEnd(46);
  const url = tab.url ? tab.url.slice(0, 35) : "";
  return `  ${id} ${adapter} ${title} ${url}`;
}

// Command: melon status
async function handleStatus(opts) {
  const hubUrl = getHubUrl(opts.hub);
  try {
    const status = await requestJson(`${hubUrl}/api/health`, { token: opts.token });
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`🍈 Melon Hub Status:`);
    console.log(`  Hub Version:       ${status.version || "0.1.0"}`);
    console.log(`  Uptime:            ${status.uptime}s`);
    console.log(`  Extension Clients: ${status.extensionClients || 0}`);
    console.log(`  Bridged Tabs:      ${status.tabs || 0}`);
    console.log(`  Active Runs:       ${status.runs || 0}`);
    console.log(`  Audit Log:         ${status.audit ? "enabled" : "disabled"}`);
    console.log(`  Worktrees Root:    ${status.worktreeRoot || "none"}`);
  } catch (err) {
    console.error(`❌ Failed to connect to Melon Hub at ${hubUrl}: ${err.message}`);
    process.exit(1);
  }
}

// Command: melon tabs
async function handleTabs(opts) {
  const hubUrl = getHubUrl(opts.hub);
  try {
    const data = await requestJson(`${hubUrl}/api/tabs`, { token: opts.token });
    const tabs = data.tabs || [];
    if (opts.json) {
      console.log(JSON.stringify(tabs, null, 2));
      return;
    }
    if (tabs.length === 0) {
      console.log("No bridged tabs connected to Melon Hub.");
      console.log("Make sure Chrome has the Melon extension active and tabs open (ChatGPT, Claude, Gemini, etc.).");
      return;
    }
    console.log(`Connected Bridged Tabs (${tabs.length}):\n`);
    console.log(`  ${"TAB ID".padEnd(12)} ${"ADAPTER".padEnd(12)} ${"TITLE".padEnd(46)} URL`);
    console.log(`  ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(46)} ${"-".repeat(30)}`);
    for (const tab of tabs) {
      console.log(formatTabRow(tab));
    }
    console.log(`\nTip: Run \`melon ask -t <TAB_ID> "Your prompt"'\` to query any tab.`);
  } catch (err) {
    console.error(`❌ Failed to retrieve tabs from Melon Hub at ${hubUrl}: ${err.message}`);
    process.exit(1);
  }
}

// Helper: resolve tab from options
async function resolveTargetTab(hubUrl, opts) {
  const data = await requestJson(`${hubUrl}/api/tabs`, { token: opts.token });
  const tabs = data.tabs || [];
  if (tabs.length === 0) {
    throw new Error("No browser tabs connected. Open ChatGPT, Claude, or Gemini in Chrome with Melon extension.");
  }

  // 1. Exact tab ID match
  if (opts.tab) {
    const match = tabs.find((t) => String(t.id) === String(opts.tab));
    if (!match) {
      throw new Error(`Tab ID ${opts.tab} not found. Run \`melon tabs\` to see available tabs.`);
    }
    return match;
  }

  // 2. Role or Adapter match
  const filter = (opts.role || opts.adapter || "").toLowerCase();
  if (filter) {
    const match = tabs.find((t) => {
      const adapter = (t.adapter || "").toLowerCase();
      const title = (t.title || "").toLowerCase();
      const url = (t.url || "").toLowerCase();
      return adapter.includes(filter) || title.includes(filter) || url.includes(filter);
    });
    if (match) return match;
    throw new Error(`No connected tab matches role/adapter "${filter}". Run \`melon tabs\` to view active tabs.`);
  }

  // 3. Default to first connected tab
  return tabs[0];
}

// Command: melon ask
async function handleAsk(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const token = opts.token || findToken();

  let prompt = opts.prompt;
  const stdin = await readStdin();
  if (stdin) {
    prompt = prompt ? `${prompt}\n\n${stdin}` : stdin;
  }

  let tab;
  try {
    tab = await resolveTargetTab(hubUrl, opts);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  // Handle extract-only mode
  if (opts.extractOnly) {
    if (!opts.silent) {
      console.error(`[melon] Extracting latest response from tab ${tab.id} (${tab.title || tab.adapter})...`);
    }
    try {
      const res = await requestJson(`${hubUrl}/api/tabs/${encodeURIComponent(tab.id)}/extract`, {
        method: "POST",
        body: { adapter: tab.adapter || opts.adapter || "auto" },
        token,
      });
      if (!res.ok) {
        throw new Error(res.error || "extraction returned not ok");
      }
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        process.stdout.write(res.text || "");
        if (res.text && !res.text.endsWith("\n")) process.stdout.write("\n");
      }
      return;
    } catch (err) {
      console.error(`❌ Extraction failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (!prompt || !prompt.trim()) {
    console.error(`❌ Error: prompt is required. Example: melon ask "Explain async generators" or pipe stdin.`);
    process.exit(1);
  }

  if (!opts.silent) {
    console.error(`[melon] Routing prompt to tab ${tab.id} (${tab.title || tab.adapter || "auto"})...`);
  }

  const runId = "cli-" + crypto.randomBytes(6).toString("base64url");

  // Open SSE event listener first so we don't miss initial streaming chunks
  const sseHeaders = { accept: "text/event-stream" };
  if (token) sseHeaders.authorization = `Bearer ${token}`;

  let sseRes;
  try {
    sseRes = await fetch(`${hubUrl}/api/events`, { headers: sseHeaders });
  } catch (err) {
    console.error(`❌ Failed to connect to event stream: ${err.message}`);
    process.exit(1);
  }

  if (!sseRes.ok || !sseRes.body) {
    console.error(`❌ Event stream rejected with HTTP ${sseRes.status}`);
    process.exit(1);
  }

  // Start run via POST /api/runs
  try {
    await requestJson(`${hubUrl}/api/runs`, {
      method: "POST",
      body: {
        runId,
        prompt,
        target: {
          type: "extension",
          tabId: tab.id,
          adapter: tab.adapter || opts.adapter || "auto",
        },
      },
      token,
    });
  } catch (err) {
    console.error(`❌ Failed to dispatch run: ${err.message}`);
    process.exit(1);
  }

  // Read SSE stream
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";
  let finalStatus = "pending";

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
          let parsed;
          try {
            parsed = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (parsed.type === "run.event" && parsed.runId === runId) {
            const ev = parsed.event || {};
            if (ev.type === "chunk" && ev.text) {
              const delta = ev.text.slice(fullOutput.length);
              fullOutput = ev.text;
              if (!opts.json) {
                process.stdout.write(delta);
              }
            } else if (ev.type === "done") {
              const text = ev.text ?? fullOutput;
              if (!opts.json && text.length > fullOutput.length) {
                process.stdout.write(text.slice(fullOutput.length));
              }
              fullOutput = text;
              finalStatus = "done";
              if (opts.json) {
                console.log(JSON.stringify({ ok: true, runId, text: fullOutput, tab: tab.id }, null, 2));
              } else if (!fullOutput.endsWith("\n")) {
                process.stdout.write("\n");
              }
              return;
            } else if (ev.type === "error") {
              finalStatus = "error";
              console.error(`\n❌ Tab execution error: ${ev.error?.message || "Unknown error"}`);
              process.exit(1);
            }
          }
        }
      }
    }
  } catch (err) {
    if (finalStatus !== "done") {
      console.error(`\n❌ Stream interrupted: ${err.message}`);
      process.exit(1);
    }
  }
}

// Command: melon export <runId>
async function handleExport(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const runId = opts.runId;
  if (!runId) {
    console.error("❌ Run ID required. Usage: melon export <runId> [--out <dir>]");
    process.exit(1);
  }
  try {
    const data = await requestJson(`${hubUrl}/api/runs/${encodeURIComponent(runId)}/artifacts`, {
      token: opts.token,
    });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const artifacts = data.artifacts || [];
    if (!artifacts.length) {
      console.log(`No artifacts harvested for run ${runId}.`);
      return;
    }
    const targetDir = path.resolve(opts.outDir || path.join(process.cwd(), ".melon", "artifacts", runId));
    fs.mkdirSync(targetDir, { recursive: true });
    for (const art of artifacts) {
      const filePath = path.join(targetDir, art.filename);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, art.content, "utf8");
      console.log(`  💾 Exported ${art.filename} (${art.content.length} chars) -> ${filePath}`);
    }
    console.log(`\nSuccessfully exported ${artifacts.length} artifacts to ${targetDir}`);
  } catch (err) {
    console.error(`❌ Export failed: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
🍈 Melon CLI (v${VERSION}) - Reverse CLI-to-Web AI Oracle

USAGE:
  melon ask [options] "<prompt>"    Dispatch prompt to bridged browser tab & stream answer
  melon ask -e [options]            Re-extract latest response from active tab without prompting
  melon tabs [options]              List all active bridged browser tabs (ChatGPT, Claude, Gemini)
  melon status [options]            Show Melon Hub runtime health and connected clients
  melon export <runId> [options]    Export code artifacts harvested from a run

ASK OPTIONS:
  -t, --tab <tabId>         Target specific browser tab ID
  -r, --role <name>         Target tab by role or model name (e.g. chatgpt, gemini, claude)
  -a, --adapter <name>      Target tab by adapter name
  -e, --extract             Extract latest response only (no new prompt sent)
  -s, --silent              Suppress connecting and routing status on stderr
  --json                    Output structured JSON response
  --hub <url>               Melon Hub URL (default: http://127.0.0.1:8787 or $MELON_HUB_URL)
  --token <token>           Authentication token (default: reads .melon-token)

EXAMPLES:
  # Query the active browser tab
  melon ask "Write an async retry utility in TypeScript"

  # Pipe terminal input directly to ChatGPT / Gemini
  cat server.log | melon ask -r chatgpt "Analyze this stack trace and suggest a fix"

  # List bridged tabs
  melon tabs

  # Re-extract the latest generated code block from tab
  melon ask -e -t 2109556133 > solution.ts
`);
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.version) {
    console.log(`melon v${VERSION}`);
    return;
  }

  if (opts.help || opts.command === "help") {
    printHelp();
    return;
  }

  switch (opts.command) {
    case "status":
      await handleStatus(opts);
      break;
    case "tabs":
      await handleTabs(opts);
      break;
    case "ask":
      await handleAsk(opts);
      break;
    case "export":
      await handleExport(opts);
      break;
    default:
      console.error(`Unknown command: "${opts.command}". Run \`melon --help\` for usage.`);
      process.exit(1);
  }
}

// Run CLI when invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

export { parseCliArgs, formatTabRow, resolveTargetTab };

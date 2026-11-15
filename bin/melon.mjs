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
import { exec } from "node:child_process";
import readline from "node:readline/promises";

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
    autoExec: false,
    retries: 2,
    query: "",
    candidates: [],
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
    } else if (arg === "--exec" || arg === "-x" || arg === "--yes" || arg === "-y") {
      parsed.autoExec = true;
    } else if (arg === "--retries") {
      parsed.retries = Math.max(0, Number(args[++i]) || 2);
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
    } else if (parsed.command === "do" || parsed.command === "run") {
      parsed.command = "do";
      parsed.prompt = positional.slice(1).join(" ");
    } else if (parsed.command === "decide" || parsed.command === "route") {
      parsed.command = "decide";
      parsed.query = positional[1] || "";
      parsed.candidates = positional.slice(2);
    } else if (parsed.command === "export") {
      parsed.runId = positional[1] || "";
    } else if (parsed.command === "tasks" || parsed.command === "ps") {
      parsed.command = "tasks";
      parsed.filter = positional[1] || "all";
    } else if (parsed.command === "resume") {
      parsed.taskId = positional[1] || "";
      parsed.prompt = positional.slice(2).join(" ");
    } else if (parsed.command === "abort") {
      parsed.taskId = positional[1] || "";
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

// Helper: extract shell commands from markdown code blocks
function extractShellCommands(text) {
  const commands = [];
  const codeBlockRegex = /```(?:bash|sh|zsh|shell)\n([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lines = match[1].trim().split("\n");
    for (const line of lines) {
      const clean = line.trim().replace(/^[$>]\s*/, "");
      if (clean && !clean.startsWith("#")) {
        commands.push(clean);
      }
    }
  }
  return commands;
}

// Helper: prompt user interactively
async function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

// Helper: execute shell command locally
function executeCommandLocally(cmd) {
  return new Promise((resolve) => {
    console.log(`\n$ ${cmd}\n`);
    const proc = exec(cmd, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
  });
}

// Command: melon do / melon run (Autonomous execution + auto-healing loop)
async function handleDo(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const token = opts.token || findToken();

  let prompt = opts.prompt;
  const stdin = await readStdin();
  if (stdin) {
    prompt = prompt ? `${prompt}\n\n${stdin}` : stdin;
  }

  if (!prompt || !prompt.trim()) {
    console.error(`❌ Error: prompt is required. Example: melon do "Build and test the project"`);
    process.exit(1);
  }

  let tab;
  try {
    tab = await resolveTargetTab(hubUrl, opts);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  let retriesRemaining = opts.retries ?? 2;
  let currentPrompt = prompt;

  while (retriesRemaining >= 0) {
    console.error(`\n🍈 [melon do] Dispatching to ${tab.adapter || tab.title || "tab"}...`);
    const runId = "cli-do-" + crypto.randomBytes(6).toString("base64url");

    const sseHeaders = { accept: "text/event-stream" };
    if (token) sseHeaders.authorization = `Bearer ${token}`;

    const sseRes = await fetch(`${hubUrl}/api/events`, { headers: sseHeaders });
    if (!sseRes.ok || !sseRes.body) {
      console.error(`❌ Event stream rejected with HTTP ${sseRes.status}`);
      process.exit(1);
    }

    await requestJson(`${hubUrl}/api/runs`, {
      method: "POST",
      body: {
        runId,
        prompt: currentPrompt,
        target: {
          type: "extension",
          tabId: tab.id,
          adapter: tab.adapter || opts.adapter || "auto",
        },
      },
      token,
    });

    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullOutput = "";

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
                process.stdout.write(delta);
              } else if (ev.type === "done") {
                const text = ev.text ?? fullOutput;
                if (text.length > fullOutput.length) {
                  process.stdout.write(text.slice(fullOutput.length));
                }
                fullOutput = text;
                break;
              } else if (ev.type === "error") {
                console.error(`\n❌ Error: ${ev.error?.message || "Unknown error"}`);
                process.exit(1);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`\nStream interrupted: ${err.message}`);
    }

    if (!fullOutput.endsWith("\n")) process.stdout.write("\n");

    const commands = extractShellCommands(fullOutput);
    if (!commands.length) {
      console.log(`\n✨ Done. (No executable commands detected in response)`);
      return;
    }

    console.log(`\n⚡ Detected ${commands.length} executable command${commands.length > 1 ? "s" : ""}:`);
    for (const cmd of commands) {
      console.log(`   $ ${cmd}`);
    }

    const commandToRun = commands[0];
    let proceed = opts.autoExec;
    if (!proceed) {
      const answer = await promptUser(`\nExecute \`$ ${commandToRun}\`? [Y/n] `);
      proceed = !answer || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    }

    if (!proceed) {
      console.log(`Command execution skipped.`);
      return;
    }

    const result = await executeCommandLocally(commandToRun);
    if (result.code === 0) {
      console.log(`\n🎉 Command succeeded!`);
      return;
    }

    if (retriesRemaining > 0) {
      console.log(`\n⚠️  Command failed (exit code ${result.code}). Triggering auto-healing loop (${retriesRemaining} retries left)...`);
      currentPrompt = `The previous command \`${commandToRun}\` failed with exit code ${result.code}.\n\nOutput / Error:\n${(result.stderr || result.stdout).slice(-2000)}\n\nPlease analyze this error, explain the root cause, and provide the corrected command/code.`;
      retriesRemaining--;
    } else {
      console.error(`\n❌ Command failed and no auto-heal retries remaining.`);
      process.exit(result.code || 1);
    }
  }
}

// Command: melon decide <query> <candidates...>
async function handleDecide(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const query = opts.query;
  const candidates = opts.candidates;

  if (!query || !candidates || candidates.length === 0) {
    console.error(`❌ Usage: melon decide "<query or state>" "<candidate 1>" "<candidate 2>" ...`);
    process.exit(1);
  }

  try {
    const res = await requestJson(`${hubUrl}/api/kev/rerank`, {
      method: "POST",
      token: opts.token,
      headers: { "content-type": "application/json" },
      body: {
        query,
        candidates: candidates.map((text, idx) => ({ id: `opt-${idx + 1}`, text })),
      },
    });

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log(`\n🧠 Decision & Reranker Result (Model: ${res.model}):\n`);
    console.log(`Query: "${query}"\n`);
    console.log("RANK".padEnd(6) + "PROBABILITY".padEnd(14) + "CANDIDATE");
    console.log("―".repeat(60));
    for (const score of res.scores || []) {
      const cand = candidates[score.index];
      const prob = `${(score.probability * 100).toFixed(1)}%`.padEnd(14);
      const rank = `#${score.rank}`.padEnd(6);
      console.log(`${rank}${prob}"${cand}"`);
    }
    console.log(`\nSelected winner: ${res.selected?.[0]} (Confidence: ${res.confidence ? `${(res.confidence * 100).toFixed(1)}%` : "N/A"})\n`);
  } catch (err) {
    console.error(`❌ Decision query failed: ${err.message}`);
    process.exit(1);
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

// Command: melon doctor
async function handleDoctor(opts) {
  const hubUrl = getHubUrl(opts.hub);
  console.log(`\n🍈 Melon Environment Diagnostic Doctor (v${VERSION})\n`);

  let issues = 0;

  // 1. Node runtime
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split(".")[0], 10);
  if (major >= 20) {
    console.log(`  [✔] Node.js Runtime:        v${nodeVer} (Supported)`);
  } else {
    console.log(`  [✗] Node.js Runtime:        v${nodeVer} (Node 20+ required!)`);
    issues++;
  }

  // 2. WASM Core
  let wasmPath = path.resolve(process.cwd(), "web", "wasm", "melon_core.wasm");
  if (!fs.existsSync(wasmPath)) {
    wasmPath = path.resolve(process.cwd(), "..", "web", "wasm", "melon_core.wasm");
  }
  if (fs.existsSync(wasmPath)) {
    const stat = fs.statSync(wasmPath);
    console.log(`  [✔] WASM Core ABI:          melon_core.wasm (${Math.round(stat.size / 1024)} KB)`);
  } else {
    console.log(`  [✗] WASM Core ABI:          web/wasm/melon_core.wasm not found`);
    issues++;
  }

  // 3. Local Hub Server
  let health = null;
  try {
    health = await requestJson(`${hubUrl}/api/health`, { token: opts.token });
    console.log(`  [✔] Local Hub Server:       Online at ${hubUrl} (v${health.version}, uptime: ${health.uptime}s)`);
  } catch (err) {
    console.log(`  [✗] Local Hub Server:       Offline at ${hubUrl} (${err.message})`);
    console.log(`      ↳ Start the hub with:   node server/hub.mjs`);
    issues++;
  }

  // 4. Token Check
  const token = opts.token || findToken();
  if (token) {
    console.log(`  [✔] Hub Security Token:     Active (${token.slice(0, 4)}…${token.slice(-3)})`);
  } else {
    console.log(`  [!] Hub Security Token:     No .melon-token file detected`);
    issues++;
  }

  // 5. Extension Clients
  if (health) {
    const clients = health.extensionClients || 0;
    if (clients > 0) {
      console.log(`  [✔] Extension Bridge:       Connected (${clients} active client)`);
    } else {
      console.log(`  [!] Extension Bridge:       0 extension clients connected`);
      console.log(`      ↳ Pair extension:       Open extension options & click '⚡ Auto-Pair with Hub'`);
      issues++;
    }
  }

  // 6. Bridged Tabs
  if (health) {
    try {
      const data = await requestJson(`${hubUrl}/api/tabs`, { token: opts.token });
      const tabs = data.tabs || [];
      if (tabs.length > 0) {
        console.log(`  [✔] Bridged AI Tabs:        ${tabs.length} open tab${tabs.length > 1 ? "s" : ""}`);
        for (const t of tabs) {
          const ready = t.health?.fields?.composer?.ok ? "ready" : "attached";
          console.log(`      • [${ready}] ${t.title ? t.title.slice(0, 35) : "Untitled"} (${t.adapter || "auto"})`);
        }
      } else {
        console.log(`  [!] Bridged AI Tabs:        0 open AI tabs detected`);
        console.log(`      ↳ Open tabs:            Open ChatGPT (https://chatgpt.com) or Claude (https://claude.ai)`);
        issues++;
      }
    } catch (err) {
      console.log(`  [!] Bridged AI Tabs:        Could not retrieve tabs (${err.message})`);
    }
  }

  // 7. Worktree Isolation
  if (health && health.worktreeRoot) {
    console.log(`  [✔] Worktrees Root:         ${health.worktreeRoot}`);
  }

  // 8. Telemetry & Errors
  if (health && health.telemetryErrors > 0) {
    console.log(`  [!] Telemetry & Errors:     ${health.telemetryErrors} captured issue(s) (run \`melon errors\` to inspect)`);
    issues++;
  } else if (health) {
    console.log(`  [✔] Telemetry & Errors:     Clean (0 active errors)`);
  }

  console.log("");
  if (issues === 0) {
    console.log(`  🎉 All systems operational! Ready to run graphs, tournaments, or \`melon ask\`.\n`);
  } else {
    console.log(`  ⚠️  ${issues} item${issues > 1 ? "s" : ""} need attention. Follow the tips above to get 100% operational.\n`);
  }
}

// Command: melon errors
async function handleErrors(opts) {
  const hubUrl = getHubUrl(opts.hub);
  try {
    const data = await requestJson(`${hubUrl}/api/telemetry/errors`, { token: opts.token });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const errors = data.errors || [];
    if (!errors.length) {
      console.log(`\n✨ Clean telemetry! No recent errors recorded.`);
      return;
    }
    console.log(`\n⚠️  Recent Captured Errors & Telemetry (${errors.length}):\n`);
    for (const err of errors) {
      const ts = err.ts ? err.ts.slice(11, 19) : "??:??:??";
      console.log(`  [${ts}] [${err.subsystem.toUpperCase()}] ${err.type}`);
      console.log(`    Message:   ${err.message}`);
      if (err.tabId) console.log(`    Tab ID:    ${err.tabId}${err.adapter ? ` (${err.adapter})` : ""}`);
      if (err.diagnosis) console.log(`    Diagnosis: 💡 ${err.diagnosis}`);
      console.log("");
    }
  } catch (err) {
    console.error(`❌ Failed to retrieve telemetry from Melon Hub at ${hubUrl}: ${err.message}`);
    process.exit(1);
  }
}

// Command: melon tasks / melon ps
async function handleTasks(opts) {
  const hubUrl = getHubUrl(opts.hub);
  try {
    const filter = opts.filter || "all";
    const data = await requestJson(`${hubUrl}/api/tasks?status=${encodeURIComponent(filter)}`, { token: opts.token });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const tasks = data.tasks || [];
    if (!tasks.length) {
      console.log(`\n📋 No tasks found (filter: ${filter}). Active: ${data.activeCount || 0}, Total: ${data.historyCount || 0}`);
      return;
    }
    console.log(`\n📋 Melon Tasks (Active: ${data.activeCount || 0}, Filter: ${filter}):\n`);
    console.log("ID".padEnd(20) + "TARGET".padEnd(16) + "STATUS".padEnd(12) + "CHARS".padStart(7) + "  " + "ELAPSED".padEnd(10) + "RESUMABLE".padEnd(11) + "PREVIEW");
    console.log("―".repeat(95));
    for (const t of tasks) {
      const id = (t.id || "").slice(0, 18).padEnd(20);
      const target = (t.target?.adapter || t.target?.type || "unknown").slice(0, 14).padEnd(16);
      const status = (t.status || "").slice(0, 10).padEnd(12);
      const chars = String(t.chars || 0).padStart(7);
      const elapsed = (t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : "-").padEnd(10);
      const resumable = (t.resumable ? "⚡ YES" : "-").padEnd(11);
      const preview = (t.text || t.target?.prompt || "").replace(/\s+/g, " ").trim().slice(0, 25);
      console.log(`${id}${target}${status}${chars}  ${elapsed}${resumable}${preview ? `"${preview}..."` : ""}`);
    }
    console.log("");
  } catch (err) {
    console.error(`❌ Failed to retrieve tasks from Melon Hub at ${hubUrl}: ${err.message}`);
    process.exit(1);
  }
}

// Command: melon resume <taskId> [continuation prompt]
async function handleResume(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const taskId = opts.taskId;
  if (!taskId) {
    console.error("❌ Error: Task ID is required. Usage: melon resume <taskId> [optional continuation prompt]");
    process.exit(1);
  }
  try {
    const res = await requestJson(`${hubUrl}/api/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: "POST",
      token: opts.token,
      headers: { "content-type": "application/json" },
      body: {
        mode: opts.extractOnly ? "extract" : "auto",
        prompt: opts.prompt || undefined,
      },
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (res.method === "extracted") {
      console.log(`\n✨ Successfully recovered task ${taskId} directly from tab! (${res.task?.chars || 0} characters)`);
      if (res.task?.text) {
        console.log(`\n${res.task.text}\n`);
      }
    } else {
      console.log(`\n⚡ Task ${taskId} resumed via continuation!`);
      console.log(`  New Run ID:  ${res.newRunId}`);
      console.log(`  Target:      ${res.task?.target?.adapter || res.task?.target?.type}`);
      console.log(`\nTip: Run \`melon tasks\` to track progress or \`melon ask -e\` to inspect output.`);
    }
  } catch (err) {
    console.error(`❌ Failed to resume task ${taskId}: ${err.message}`);
    process.exit(1);
  }
}

// Command: melon abort <taskId>
async function handleAbort(opts) {
  const hubUrl = getHubUrl(opts.hub);
  const taskId = opts.taskId;
  if (!taskId) {
    console.error("❌ Error: Task ID is required. Usage: melon abort <taskId>");
    process.exit(1);
  }
  try {
    const res = await requestJson(`${hubUrl}/api/tasks/${encodeURIComponent(taskId)}/abort`, {
      method: "POST",
      token: opts.token,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`\n🛑 Task ${taskId} aborted.`);
  } catch (err) {
    console.error(`❌ Failed to abort task ${taskId}: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
🍈 Melon CLI (v${VERSION}) - Reverse CLI-to-Web AI Oracle

USAGE:
  melon do [options] "<task>"       Autonomous task runner: runs in web, executes commands & auto-heals
  melon ask [options] "<prompt>"    Dispatch prompt to bridged browser tab & stream answer
  melon ask -e [options]            Re-extract latest response from active tab without prompting
  melon tabs [options]              List all active bridged browser tabs (ChatGPT, Claude, Gemini)
  melon decide "<query>" <opts...>  Rerank candidates using local embedded decision engine
  melon tasks [filter] [options]    List async tasks, status & partial checkpoints (alias: melon ps)
  melon resume <taskId> [options]   Gracefully resume or recover an interrupted task
  melon abort <taskId> [options]    Abort an in-flight background task
  melon doctor [options]            Run self-healing diagnostic check on local setup & tabs
  melon errors [options]            Inspect real-time telemetry, adapter errors & root causes
  melon status [options]            Show Melon Hub runtime health and connected clients
  melon export <runId> [options]    Export code artifacts harvested from a run

OPTIONS:
  -t, --tab <tabId>         Target specific browser tab ID
  -r, --role <name>         Target tab by role or model name (e.g. chatgpt, gemini, claude)
  -a, --adapter <name>      Target tab by adapter name
  -e, --extract             Extract latest response only (no new prompt sent)
  -x, --exec, -y, --yes     Auto-execute extracted commands without asking confirmation
  --retries <n>             Maximum auto-healing retry iterations on command failure (default: 2)
  -s, --silent              Suppress connecting and routing status on stderr
  --json                    Output structured JSON response
  --hub <url>               Melon Hub URL (default: http://127.0.0.1:8787 or $MELON_HUB_URL)
  --token <token>           Authentication token (default: reads .melon-token)

EXAMPLES:
  # Autonomous runner: runs on tab, prompts to execute code, and auto-fixes failures!
  melon do "Run the task test suite and fix any broken tests"
  melon do -y "Build the extension zip package"

  # Query the active browser tab
  melon ask "Write an async retry utility in TypeScript"

  # Rerank decisions with local Kev-like model
  melon decide "auth validation" "Postgres connection" "OAuth JWT token handler" "CSS styles"

  # View in-flight and recent async tasks
  melon tasks
  melon tasks resumable

  # Gracefully recover or resume an interrupted task
  melon resume run_1731675200

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
    case "tasks":
      await handleTasks(opts);
      break;
    case "resume":
      await handleResume(opts);
      break;
    case "abort":
      await handleAbort(opts);
      break;
    case "ask":
      await handleAsk(opts);
      break;
    case "do":
      await handleDo(opts);
      break;
    case "decide":
      await handleDecide(opts);
      break;
    case "export":
      await handleExport(opts);
      break;
    case "doctor":
      await handleDoctor(opts);
      break;
    case "errors":
      await handleErrors(opts);
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

export { parseCliArgs, formatTabRow, resolveTargetTab, handleDoctor, handleErrors, handleTasks, handleResume, handleAbort, handleDo, handleDecide, extractShellCommands };

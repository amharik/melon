import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isTauri,
  pingTauri,
  tauriInvoke,
  spawnAgentWebview,
  toggleAgentWebview,
  evalAgentScript,
  getAgentWindowTitle,
  isAgentWindowOpen,
  closeAgentWindow,
  getAgentMessage,
  clearAgentMessage,
  runCliAgent,
  buildAuthCheckScript,
  buildPromptInjectionScript,
  buildResponseExtractScript,
  WEB_AGENT_DEFAULTS,
  apiUrl,
} from "../web/shared/tauri_bridge.js";

test("Tauri desktop bridge detects non-Tauri browser environments safely", () => {
  // In standard node/browser environment without __TAURI__
  assert.equal(isTauri(), false);
});

test("Tauri desktop bridge detects Tauri 2.0 environment and invokes commands", async () => {
  const calls = [];
  const fakeTauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "ping") return "melon-tauri-ok";
        if (cmd === "spawn_agent_window") return true;
        if (cmd === "toggle_agent_window") return true;
        if (cmd === "eval_agent_script") return true;
        if (cmd === "run_cli_agent") return true;
        return null;
      },
    },
    event: {
      listen: async (eventName, callback) => {
        return () => {};
      },
    },
  };

  // Mock window.__TAURI__
  globalThis.window = { __TAURI__: fakeTauri };

  try {
    assert.equal(isTauri(), true);

    const ping = await pingTauri();
    assert.equal(ping, "melon-tauri-ok");

    const spawned = await spawnAgentWebview({
      id: "chatgpt",
      title: "ChatGPT Agent",
      url: "https://chatgpt.com",
      visible: true,
    });
    assert.equal(spawned, true);

    const toggled = await toggleAgentWebview("chatgpt", false);
    assert.equal(toggled, true);

    const evalRes = await evalAgentScript("chatgpt", "console.log('hi');");
    assert.equal(evalRes, true);

    assert.equal(calls.length, 4);
    assert.equal(calls[0].cmd, "ping");
    assert.equal(calls[1].cmd, "spawn_agent_window");
    assert.equal(calls[1].args.config.id, "chatgpt");
    assert.equal(calls[2].cmd, "toggle_agent_window");
    assert.equal(calls[3].cmd, "eval_agent_script");
  } finally {
    delete globalThis.window;
  }
});

test("Tauri desktop bridge handles CLI agent streaming output and events", async () => {
  let registeredListener = null;
  const calls = [];

  const fakeTauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return true;
      },
    },
    event: {
      listen: async (eventName, callback) => {
        if (eventName === "cli-output") {
          registeredListener = callback;
        }
        return () => {};
      },
    },
  };

  globalThis.window = { __TAURI__: fakeTauri };

  try {
    const chunks = [];
    let completed = false;

    const runPromise = runCliAgent(
      {
        runId: "run_123",
        agentName: "Agy Worker",
        command: "agy",
        args: ["run"],
        prompt: "Review the system boundaries",
      },
      {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: () => {
          completed = true;
        },
        onError: () => {},
      },
    );

    const started = await runPromise;
    assert.equal(started, true);
    assert.ok(registeredListener, "listener should be registered");

    // Simulate stdout stream events
    registeredListener({
      payload: {
        run_id: "run_123",
        agent_name: "Agy Worker",
        chunk: "Starting review...\n",
        is_done: false,
        is_error: false,
      },
    });

    registeredListener({
      payload: {
        run_id: "run_123",
        agent_name: "Agy Worker",
        chunk: "Review complete.\n",
        is_done: true,
        is_error: false,
      },
    });

    assert.deepEqual(chunks, ["Starting review...\n", "Review complete.\n"]);
    assert.equal(completed, true);
  } finally {
    delete globalThis.window;
  }
});

test("src-tauri configuration and Rust backend are structurally valid", () => {
  const tauriConfPath = path.resolve("src-tauri/tauri.conf.json");
  assert.ok(fs.existsSync(tauriConfPath), "tauri.conf.json should exist");
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  assert.equal(tauriConf.productName, "melon");
  assert.equal(tauriConf.build.frontendDist, "../web");

  const cargoTomlPath = path.resolve("src-tauri/Cargo.toml");
  assert.ok(fs.existsSync(cargoTomlPath), "Cargo.toml should exist");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  assert.ok(cargoToml.includes('name = "app"'));
  assert.ok(cargoToml.includes("2.12.6"));

  const libRsPath = path.resolve("src-tauri/src/lib.rs");
  assert.ok(fs.existsSync(libRsPath), "src/lib.rs should exist");
  const libRs = fs.readFileSync(libRsPath, "utf8");
  assert.ok(libRs.includes("spawn_agent_window"));
  assert.ok(libRs.includes("toggle_agent_window"));
  assert.ok(libRs.includes("eval_agent_script"));
  assert.ok(libRs.includes("run_cli_agent"));
  assert.ok(libRs.includes("get_agent_window_title"));
  assert.ok(libRs.includes("is_agent_window_open"));
  assert.ok(libRs.includes("close_agent_window"));
});

test("WEB_AGENT_DEFAULTS catalog supports ChatGPT, Claude, Gemini, DeepSeek, and Mistral", () => {
  assert.ok(WEB_AGENT_DEFAULTS.chatgpt);
  assert.equal(WEB_AGENT_DEFAULTS.chatgpt.url, "https://chatgpt.com");
  assert.equal(WEB_AGENT_DEFAULTS.chatgpt.tag, "CHATGPT");

  assert.ok(WEB_AGENT_DEFAULTS.claude);
  assert.equal(WEB_AGENT_DEFAULTS.claude.url, "https://claude.ai");
  assert.equal(WEB_AGENT_DEFAULTS.claude.tag, "CLAUDE");

  assert.ok(WEB_AGENT_DEFAULTS.gemini);
  assert.equal(WEB_AGENT_DEFAULTS.gemini.url, "https://gemini.google.com");
  assert.equal(WEB_AGENT_DEFAULTS.gemini.tag, "GEMINI");

  assert.ok(WEB_AGENT_DEFAULTS.deepseek);
  assert.equal(WEB_AGENT_DEFAULTS.deepseek.url, "https://chat.deepseek.com");

  assert.ok(WEB_AGENT_DEFAULTS.mistral);
  assert.equal(WEB_AGENT_DEFAULTS.mistral.url, "https://chat.mistral.ai");
});

test("Tauri bridge manages window title, open state, and close commands", async () => {
  const calls = [];
  const fakeTauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "get_agent_window_title") return "ChatGPT · Melon Agent";
        if (cmd === "is_agent_window_open") return true;
        if (cmd === "close_agent_window") return true;
        return null;
      },
    },
  };

  globalThis.window = { __TAURI__: fakeTauri };
  try {
    const title = await getAgentWindowTitle("chatgpt");
    assert.equal(title, "ChatGPT · Melon Agent");

    const isOpen = await isAgentWindowOpen("chatgpt");
    assert.equal(isOpen, true);

    const closed = await closeAgentWindow("chatgpt");
    assert.equal(closed, true);

    assert.equal(calls.length, 3);
    assert.equal(calls[0].cmd, "get_agent_window_title");
    assert.equal(calls[1].cmd, "is_agent_window_open");
    assert.equal(calls[2].cmd, "close_agent_window");
  } finally {
    delete globalThis.window;
  }
});

test("Prompt injection script and response extraction script generate expected code", () => {
  const injectCode = buildPromptInjectionScript("Analyze architecture", "run_abc");
  assert.ok(injectCode.includes("Analyze architecture"));
  assert.ok(injectCode.includes("run_abc"));
  assert.ok(injectCode.includes("needs_auth"));
  assert.ok(injectCode.includes("__melon_msg__:"));

  const extractCode = buildResponseExtractScript("run_abc");
  assert.ok(extractCode.includes("run_abc"));
  assert.ok(extractCode.includes("extracted"));
  assert.ok(extractCode.includes("model-response"));
  assert.ok(extractCode.includes("font-claude-message"));
  assert.ok(extractCode.includes("__melon_msg__:"));
});

test("DOM markup and CSS expose sidebar collapse, AI service selection, and auth controls", () => {
  const html = fs.readFileSync(path.resolve("web/index.html"), "utf8");
  assert.ok(html.includes('id="btn-toggle-slack-sidebar"'));
  assert.ok(html.includes('id="btn-expand-slack-sidebar"'));
  assert.ok(html.includes('id="btn-chat-authorize"'));
  assert.ok(html.includes('id="contact-model-service"'));
  assert.ok(html.includes('id="group-contact-model"'));

  const css = fs.readFileSync(path.resolve("web/styles.css"), "utf8");
  assert.ok(css.includes(".slack-sidebar.collapsed"));
  assert.ok(css.includes(".btn-sidebar-toggle"));
  assert.ok(css.includes(".btn-sidebar-expand"));
  assert.ok(css.includes(".agent-type-tag.web"));

  const appJs = fs.readFileSync(path.resolve("web/app.js"), "utf8");
  assert.ok(appJs.includes("setSidebarCollapsed"));
  assert.ok(appJs.includes("melon.slack_sidebar_collapsed"));
  assert.ok(appJs.includes("btn-open-auth-window"));
  assert.ok(appJs.includes("btn-profile-open-auth"));
});

test("Tauri bridge manages custom IPC agent messages and auth probe script", async () => {
  const calls = [];
  const fakeTauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "get_agent_message") return JSON.stringify({ authed: true });
        if (cmd === "clear_agent_message") return true;
        return null;
      },
    },
  };

  globalThis.window = { __TAURI__: fakeTauri };
  try {
    const msg = await getAgentMessage("chatgpt");
    assert.deepEqual(msg, { authed: true });

    const cleared = await clearAgentMessage("chatgpt");
    assert.equal(cleared, true);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].cmd, "get_agent_message");
    assert.equal(calls[0].args.id, "chatgpt");
    assert.equal(calls[1].cmd, "clear_agent_message");
    assert.equal(calls[1].args.id, "chatgpt");

    const authScript = buildAuthCheckScript("chatgpt");
    assert.ok(authScript.includes("melon-bridge://"));
    assert.ok(authScript.includes("chatgpt"));
    assert.ok(authScript.includes("#prompt-textarea"));
    assert.ok(authScript.includes("login-button"));
  } finally {
    delete globalThis.window;
  }
});

test("Rust lib.rs contains melon-bridge IPC and message handlers", () => {
  const libRs = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
  assert.ok(libRs.includes("get_agent_message"));
  assert.ok(libRs.includes("clear_agent_message"));
  assert.ok(libRs.includes("melon-bridge"));
  assert.ok(libRs.includes("agent_messages"));
});

test("CSS styles contain active/needs-auth states for buttons and presence dots", () => {
  const css = fs.readFileSync(path.resolve("web/styles.css"), "utf8");
  assert.ok(css.includes(".btn-chat-authorize.authed"));
  assert.ok(css.includes(".btn-chat-authorize.needs-auth"));
  assert.ok(css.includes(".presence-dot.online.authed"));
  assert.ok(css.includes(".presence-dot.idle.unauthed"));
});

test("apiUrl maps relative paths to localhost:4096 in Tauri environment", () => {
  // In normal browser
  assert.equal(apiUrl("/api/runs"), "/api/runs");

  // In Tauri desktop environment
  globalThis.window = {
    __TAURI__: { core: { invoke: () => {} } },
    location: {
      origin: "http://tauri.localhost",
      protocol: "http:",
    },
  };
  try {
    assert.equal(apiUrl("/api/runs"), "http://127.0.0.1:4096/api/runs");
    assert.equal(apiUrl("api/messages"), "http://127.0.0.1:4096/api/messages");
  } finally {
    delete globalThis.window;
  }
});

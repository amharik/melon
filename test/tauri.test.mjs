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
  runCliAgent,
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
  assert.ok(cargoToml.includes('tauri = { version = "2.12.6" }'));

  const libRsPath = path.resolve("src-tauri/src/lib.rs");
  assert.ok(fs.existsSync(libRsPath), "src/lib.rs should exist");
  const libRs = fs.readFileSync(libRsPath, "utf8");
  assert.ok(libRs.includes("spawn_agent_window"));
  assert.ok(libRs.includes("toggle_agent_window"));
  assert.ok(libRs.includes("eval_agent_script"));
  assert.ok(libRs.includes("run_cli_agent"));
});

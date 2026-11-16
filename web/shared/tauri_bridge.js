/**
 * Melon Tauri Native Desktop Bridge
 * Enables direct communication with Tauri 2.0 Rust backend,
 * managing child webviews (ChatGPT, Gemini, Claude) and native CLI agents (opencode, agy).
 */

export function isTauri() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.__TAURI_INTERNALS__ ||
      (window.__TAURI__ && typeof window.__TAURI__.core?.invoke === "function"),
  );
}

export async function tauriInvoke(cmd, args = {}) {
  if (!isTauri()) return null;
  const invokeFn =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI__?.invoke ||
    window.__TAURI_INTERNALS__?.invoke;
  if (typeof invokeFn === "function") {
    return await invokeFn(cmd, args);
  }
  return null;
}

export async function pingTauri() {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke("ping");
  } catch (err) {
    console.warn("[TauriBridge] ping error:", err);
    return null;
  }
}

export async function spawnAgentWebview({ id, title, url, visible = false }) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("spawn_agent_window", {
      config: { id, title, url, visible },
    });
  } catch (err) {
    console.error(`[TauriBridge] failed to spawn agent webview ${id}:`, err);
    return false;
  }
}

export async function toggleAgentWebview(id, visible = null) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("toggle_agent_window", { id, visible });
  } catch (err) {
    console.error(`[TauriBridge] failed to toggle agent webview ${id}:`, err);
    return false;
  }
}

export async function evalAgentScript(id, script) {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke("eval_agent_script", { id, script });
  } catch (err) {
    console.error(`[TauriBridge] failed to eval script in webview ${id}:`, err);
    return false;
  }
}

export async function runCliAgent(
  { runId, agentName, command, args = [], prompt, cwd = null },
  { onChunk, onDone, onError },
) {
  if (!isTauri()) return false;

  const eventApi = window.__TAURI__?.event || window.__TAURI_INTERNALS__?.event;
  let unlisten = null;

  if (eventApi && typeof eventApi.listen === "function") {
    unlisten = await eventApi.listen("cli-output", (event) => {
      const payload = event.payload || {};
      if (payload.run_id !== runId) return;

      if (payload.chunk && typeof onChunk === "function") {
        onChunk(payload.chunk);
      }

      if (payload.is_done) {
        if (payload.is_error && typeof onError === "function") {
          onError(payload.chunk || "Process exited with error");
        } else if (typeof onDone === "function") {
          onDone();
        }
        if (typeof unlisten === "function") {
          unlisten();
        }
      }
    });
  }

  try {
    await tauriInvoke("run_cli_agent", {
      req: {
        run_id: runId,
        agent_name: agentName,
        command,
        args,
        prompt,
        cwd,
      },
    });
    return true;
  } catch (err) {
    if (typeof onError === "function") onError(String(err));
    if (typeof unlisten === "function") unlisten();
    return false;
  }
}

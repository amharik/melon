// Melon Telemetry & Real-Time Error Capture Engine.
//
// Records, buffers, and diagnoses errors across all subsystems:
// DOM adapters, extension bridge, WASM core, hub server, and CLI.

import fs from "node:fs";
import path from "node:path";

const MAX_BUFFER = 100;

export function createTelemetryTracker({ file = "", now = () => new Date() } = {}) {
  const ringBuffer = [];
  const enabledFile = Boolean(file);

  if (enabledFile) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {}
  }

  function record(entry = {}) {
    const ts = now().toISOString();
    const event = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts,
      level: entry.level || "error",
      subsystem: entry.subsystem || "hub",
      type: entry.type || "runtime_error",
      message: String(entry.message || "Unknown error").slice(0, 1000),
      tabId: entry.tabId ?? null,
      adapter: entry.adapter || null,
      nodeId: entry.nodeId || null,
      runId: entry.runId || null,
      stack: entry.stack ? String(entry.stack).slice(0, 2000) : null,
      context: entry.context || {},
      diagnosis: diagnoseError(entry),
    };

    ringBuffer.unshift(event);
    if (ringBuffer.length > MAX_BUFFER) {
      ringBuffer.pop();
    }

    if (enabledFile) {
      try {
        fs.appendFileSync(file, JSON.stringify(event) + "\n", { mode: 0o600 });
      } catch {}
    }

    return event;
  }

  function list(limit = 20) {
    return ringBuffer.slice(0, Math.max(1, Math.min(100, limit)));
  }

  function clear() {
    ringBuffer.length = 0;
  }

  return {
    record,
    list,
    clear,
    get size() {
      return ringBuffer.length;
    },
  };
}

/**
 * Heuristic auto-diagnostician: analyzes error signatures and provides actionable root-cause advice.
 */
function diagnoseError(entry) {
  const msg = (entry.message || "").toLowerCase();
  const sub = (entry.subsystem || "").toLowerCase();

  if (msg.includes("timed out waiting for a response") || msg.includes("timeout")) {
    return "The model tab stalled or background tab throttling clamped timers. Re-extract response or verify tab is not occluded.";
  }
  if (
    msg.includes("no visible match") ||
    msg.includes("cannot find composer") ||
    msg.includes("no melon adapter")
  ) {
    return "Site DOM changed or user is on login/CAPTCHA wall. Reload the tab and verify page is in an active chat.";
  }
  if (msg.includes("econnrefused") || msg.includes("failed to fetch") || msg.includes("websocket")) {
    return "Network connection to local hub was lost or port is blocked. Ensure `node server/hub.mjs` is running.";
  }
  if (msg.includes("origin not allowed") || msg.includes("unauthorized")) {
    return "CORS or token validation failed. Auto-pair the extension with the hub in extension options.";
  }
  if (msg.includes("wasm") || msg.includes("out of memory")) {
    return "WASM core memory or ABI mismatch. Check melon_core.wasm integrity.";
  }

  return sub === "adapter"
    ? "DOM selector mismatch with provider frontend. Run `melon ask -e` or refresh site adapter pack."
    : "Inspect recent audit logs and ensure all dependencies are active.";
}

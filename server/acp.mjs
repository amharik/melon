// Minimal Agent Client Protocol (ACP) stdio client.
//
// Agents are local subprocesses speaking ACP v1 over newline-delimited
// JSON-RPC. Melon never opens a listening port for ACP; the hub starts the
// configured command with piped stdio and streams agent_message_chunk text
// back as run events. Permission requests are denied by default so a model
// cannot silently approve its own sensitive tool calls.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/g, "");
}

export function createAcpClient({
  command = "",
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 300000,
  onPermission = null,
  onInitialize = null,
} = {}) {
  let active = null;

  async function run(prompt, { cwd: runCwd = cwd, signal = null, onChunk = null } = {}) {
    if (!command) throw new Error("ACP_CMD is not configured");
    const child = spawn(command, Array.isArray(args) ? args : [], {
      cwd: runCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    active = child;

    let stderr = "";
    child.stderr.on("data", (buffer) => {
      stderr = `${stderr}${buffer.toString()}`.slice(-4000);
    });
    child.on("error", (err) => {
      stderr = `${stderr}\n${err.message}`.slice(-4000);
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const app = acp.client({ name: "melon-hub" });
    app.onRequest(acp.methods.client.session.requestPermission, async (params) => {
      if (typeof onPermission === "function") return onPermission(params);
      return { outcome: { outcome: "cancelled" } };
    });

    const abort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(abort, Math.max(1000, Number(timeoutMs) || 300000));
    timer.unref?.();

    try {
      return await app.connectWith(stream, async (ctx) => {
        const initialized = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "melon-hub", version: "0.1.0" },
        });
        if (typeof onInitialize === "function") onInitialize(initialized);

        const session = await ctx.buildSession(runCwd).start();
        let text = "";
        const response = session.prompt(cleanText(prompt));
        try {
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") break;
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
              text += update.content.text;
              if (typeof onChunk === "function") onChunk(update.content.text);
            }
          }
          await response;
        } finally {
          session.dispose?.();
        }
        return text;
      });
    } catch (err) {
      const message = String(err?.message || err);
      const detail = stderr.trim();
      throw new Error(detail && !message.includes(detail) ? `${message}: ${detail.slice(-1000)}` : message);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      if (active === child) active = null;
      try {
        child.kill("SIGTERM");
      } catch {}
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 1000);
      killer.unref?.();
    }
  }

  function close() {
    const child = active;
    active = null;
    try {
      child?.kill("SIGTERM");
    } catch {}
  }

  return { run, close, enabled: !!command };
}

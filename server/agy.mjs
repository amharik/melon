// Generic stdio CLI adapter. Melon does not assume a vendor protocol: it spawns
// a command and speaks newline-delimited JSON in both directions, tolerating the
// common stream shapes used by coding CLIs. `agy` is the first consumer, but any
// stream-json compatible binary can be configured with AGY_CMD / AGY_ARGS.

import { spawn as defaultSpawn } from "node:child_process";

export function splitArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value || "").trim();
  if (!text) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(re)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function textFromEvent(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.text === "string") return data.text;
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.content === "string") return data.content;
  if (typeof data.chunk === "string") return data.chunk;
  if (typeof data.part?.text === "string") return data.part.text;
  if (typeof data.step_update?.text_delta === "string") return data.step_update.text_delta;
  if (typeof data.result?.response === "string") return data.result.response;
  if (typeof data.message?.content === "string") return data.message.content;
  if (Array.isArray(data.message?.content)) {
    return data.message.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  if (Array.isArray(data.content)) {
    return data.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

export function parseAgyLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { type: "chunk", text: trimmed + "\n" };
  }
  const eventType = data?.event || data?.type;
  if (
    eventType === "error" ||
    data?.error ||
    (data?.event === "result" && data?.result?.status === "ERROR")
  ) {
    return {
      type: "error",
      message:
        data.error?.message ||
        data.result?.error ||
        (typeof data.error === "string" ? data.error : data.message) ||
        "CLI agent reported an error",
    };
  }
  const text = textFromEvent(data);
  if (
    eventType === "done" ||
    eventType === "complete" ||
    eventType === "result" ||
    (data?.step_update?.state === "DONE" && data?.step_update?.step_type === "agent_response")
  ) {
    if (eventType === "result" || eventType === "done" || eventType === "complete") {
      return { type: "done", text: data.result?.response || text };
    }
  }
  if (text) return { type: "chunk", text };
  return null;
}

function promptFrame(prompt, inputFormat) {
  if (inputFormat === "prompt") return { event: "prompt", type: "prompt", prompt };
  return {
    event: "user",
    type: "user",
    message: { role: "user", content: prompt },
  };
}

export function createAgyRunner({ cmd = process.env.AGY_CMD || "agy", args = [], spawn = defaultSpawn, inputFormat = process.env.AGY_INPUT_FORMAT || "stream-json" } = {}) {
  function run({ prompt, cwd, signal, onChunk = () => {}, env } = {}) {
    return new Promise((resolve, reject) => {
      if (!cmd) {
        reject(new Error("AGY_CMD is not configured"));
        return;
      }
      let child;
      try {
        child = spawn(cmd, args, {
          cwd,
          env: env || process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err);
        return;
      }

      let full = "";
      let finalText = null;
      let stderr = "";
      let settled = false;
      let buffer = "";
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value ?? full);
      };
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1500).unref?.();
        finish(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const consume = (line) => {
        const event = parseAgyLine(line);
        if (!event) return;
        if (event.type === "chunk") {
          full += event.text;
          onChunk(event.text);
        } else if (event.type === "done") {
          if (event.text) {
            finalText = event.text;
            if (!full.startsWith(event.text)) {
              full += event.text;
              onChunk(event.text);
            }
          }
        } else if (event.type === "error") {
          finish(new Error(event.message));
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) consume(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });
      child.on("error", (err) => finish(err));
      child.on("close", (code) => {
        if (buffer.trim()) consume(buffer);
        if (settled) return;
        if (code === 0) finish(null, finalText ?? full);
        else finish(new Error(stderr.trim() || `CLI agent exited with code ${code}`));
      });

      try {
        child.stdin.write(JSON.stringify(promptFrame(String(prompt || ""), inputFormat)) + "\n");
        child.stdin.end();
      } catch (err) {
        finish(err);
      }
    });
  }

  return { run, cmd, args, inputFormat };
}

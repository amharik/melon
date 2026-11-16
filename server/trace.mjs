import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SAFE_VALUE = ["string", "number", "boolean"];
const SENSITIVE = /^(prompt|text|output|command|content|message|body|html|token|key|secret|password|query|reason)$/i;

function clean(attrs = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SENSITIVE.test(key)) continue;
    if (!SAFE_VALUE.includes(typeof value)) continue;
    out[String(key).slice(0, 60)] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return out;
}

export function createTracer({ file = "", now = () => new Date() } = {}) {
  const enabled = Boolean(file);
  const traceId = crypto.randomBytes(12).toString("hex");

  if (enabled) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  function write(event) {
    if (!enabled) return false;
    try {
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  function span(name, attrs = {}, parent = null) {
    const id = crypto.randomBytes(8).toString("hex");
    const parentSpanId = parent?.id || (typeof parent === "string" ? parent : null);
    const started = Date.now();
    let ended = false;
    const base = {
      traceId,
      spanId: id,
      parentSpanId,
      name: String(name).slice(0, 80),
    };
    if (enabled) {
      write({ ts: now().toISOString(), type: "span.start", ...base, attrs: clean(attrs) });
    }

    function end(extra = {}) {
      if (ended) return false;
      ended = true;
      return write({
        ts: now().toISOString(),
        type: "span.end",
        ...base,
        durationMs: Date.now() - started,
        status: extra.status || "ok",
        attrs: clean(extra),
      });
    }

    return {
      id,
      traceId,
      name: base.name,
      parentSpanId,
      end,
      error(err, extra = {}) {
        end({
          ...extra,
          status: "error",
          error: String(err?.message || err || "unknown error").slice(0, 300),
        });
      },
    };
  }

  return { enabled, file, traceId, span };
}

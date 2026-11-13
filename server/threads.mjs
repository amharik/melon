// In-memory conversational thread state. The Rust core stays a pure dataflow
// scheduler; the hub owns multi-turn context as an optional host-level feature.
// Nothing here is persisted.

const MAX_THREADS = 200;
const MAX_MESSAGES = 200;

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

export function createThreadStore({ now = () => Date.now(), maxThreads = MAX_THREADS, maxMessages = MAX_MESSAGES } = {}) {
  const threads = new Map();

  function record(id) {
    return threads.get(String(id)) || null;
  }

  function create({ id, title } = {}) {
    const threadId = String(id || `thread_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    if (threads.has(threadId)) return clone(threads.get(threadId));
    const thread = {
      id: threadId,
      title: String(title || "Office thread").slice(0, 160),
      createdAt: now(),
      updatedAt: now(),
      status: "idle",
      runIds: [],
      messages: [],
    };
    threads.set(threadId, thread);
    while (threads.size > maxThreads) {
      const oldest = threads.keys().next().value;
      threads.delete(oldest);
    }
    return clone(thread);
  }

  function ensure(id, options = {}) {
    const existing = record(id);
    if (existing) {
      if (options.title && existing.title === "Office thread") existing.title = String(options.title).slice(0, 160);
      return clone(existing);
    }
    return create({ ...options, id });
  }

  function get(id) {
    const thread = record(id);
    return thread ? clone(thread) : null;
  }

  function list() {
    return [...threads.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        status: thread.status,
        runs: thread.runIds.length,
        messages: thread.messages.length,
      }));
  }

  function append(id, message = {}) {
    const thread = record(id);
    if (!thread) return null;
    const entry = {
      role: ["user", "assistant", "system", "tool"].includes(message.role) ? message.role : "system",
      text: String(message.text || "").slice(0, 200000),
      runId: message.runId ? String(message.runId) : null,
      node: message.node ? String(message.node) : null,
      taint: message.taint === "untrusted" ? "untrusted" : null,
      at: now(),
    };
    thread.messages.push(entry);
    if (thread.messages.length > maxMessages) thread.messages.splice(0, thread.messages.length - maxMessages);
    if (message.runId && !thread.runIds.includes(String(message.runId))) {
      thread.runIds.push(String(message.runId));
      if (thread.runIds.length > maxMessages) thread.runIds.splice(0, thread.runIds.length - maxMessages);
    }
    thread.updatedAt = now();
    return clone(entry);
  }

  function setStatus(id, status) {
    const thread = record(id);
    if (!thread) return false;
    thread.status = String(status || "idle");
    thread.updatedAt = now();
    return true;
  }

  function remove(id) {
    return threads.delete(String(id));
  }

  return { create, ensure, get, list, append, setStatus, remove };
}

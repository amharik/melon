// Melon Task Manager: Async task tracking, checkpointing, and graceful resume.
//
// Manages the lifecycle of async operations across tabs, opencode, agy, and LLM:
// queued -> thinking -> streaming -> done / error / cancelled / resumable.

const MAX_TASK_HISTORY = 60;

export function createTaskStore() {
  const tasks = new Map(); // id -> TaskRecord
  const history = []; // Array of completed TaskRecords (newest first)

  function create({ id, target, threadId = null }) {
    const task = {
      id,
      target: {
        type: target.type || "extension",
        tabId: target.tabId ?? null,
        adapter: target.adapter || "auto",
        label: target.label || null,
        node: target.node || null,
        prompt: target.prompt || "",
      },
      threadId,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      chars: 0,
      text: "",
      partialText: "",
      error: null,
      resumable: false,
      resumeCount: 0,
    };
    tasks.set(id, task);
    return task;
  }

  function get(id) {
    return tasks.get(id) || history.find((t) => t.id === id) || null;
  }

  function update(id, updates = {}) {
    const task = tasks.get(id);
    if (!task) return null;

    if (updates.status && task.status !== updates.status) {
      task.status = updates.status;
      if (updates.status === "thinking" || updates.status === "streaming") {
        if (!task.startedAt) task.startedAt = Date.now();
      }
    }

    if (updates.text !== undefined) {
      task.text = String(updates.text);
      task.chars = task.text.length;
    }

    if (updates.error !== undefined) {
      task.error = updates.error;
    }

    if (task.startedAt) {
      task.durationMs = Date.now() - task.startedAt;
    }

    return task;
  }

  function finish(id, { status = "done", text = null, error = null } = {}) {
    const task = tasks.get(id);
    if (!task) return null;

    task.completedAt = Date.now();
    task.durationMs = task.startedAt ? task.completedAt - task.startedAt : 0;
    task.status = status;

    if (text !== null) {
      task.text = String(text);
      task.chars = task.text.length;
    }

    if (status === "error" || status === "cancelled") {
      task.partialText = task.text;
      task.resumable = true;
      task.error = error;
    } else {
      task.resumable = false;
    }

    tasks.delete(id);
    history.unshift({ ...task });
    if (history.length > MAX_TASK_HISTORY) {
      history.pop();
    }

    return task;
  }

  function markResumed(id) {
    const task = get(id);
    if (!task || !task.resumable) return null;

    task.resumable = false;
    task.resumeCount = (task.resumeCount || 0) + 1;
    task.status = "thinking";
    task.startedAt = Date.now();
    task.completedAt = null;

    // Move back into active tasks map if it was in history
    tasks.set(id, task);
    const histIdx = history.findIndex((t) => t.id === id);
    if (histIdx >= 0) history.splice(histIdx, 1);

    return task;
  }

  function list({ status = "all", limit = 30 } = {}) {
    const active = [...tasks.values()];
    let all = [...active, ...history];

    if (status === "active") {
      all = active;
    } else if (status === "resumable") {
      all = all.filter((t) => t.resumable);
    } else if (status !== "all") {
      all = all.filter((t) => t.status === status);
    }

    return all.slice(0, Math.max(1, Math.min(100, limit)));
  }

  return {
    create,
    get,
    update,
    finish,
    markResumed,
    list,
    get activeCount() {
      return tasks.size;
    },
    get historyCount() {
      return history.length;
    },
  };
}

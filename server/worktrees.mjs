// Isolated git worktrees for CLI agents. The hub only permits tool execution
// inside the configured root, and creates one branch per worktree. This is
// process-level isolation, not a container: the command still runs as the local
// user, so the approval gate remains the primary control.

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export function createWorktreeManager({ root, repo, git = "git" } = {}) {
  if (!root) throw new Error("worktree root is required");
  const resolvedRoot = path.resolve(root);

  function inside(candidate) {
    const resolved = path.resolve(candidate);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  }

  function resolve(candidate) {
    if (!candidate) return resolvedRoot;
    const resolved = path.resolve(resolvedRoot, candidate);
    if (!inside(resolved)) throw new Error("path escapes the worktree root");
    return resolved;
  }

  function validateName(name) {
    const value = String(name || "").trim();
    if (!NAME_RE.test(value)) throw new Error("worktree name must be alphanumeric with . _ -");
    return value;
  }

  async function ensureRoot() {
    await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  }

  async function add({ name, base = "HEAD" } = {}) {
    const safe = validateName(name);
    await ensureRoot();
    const target = path.join(resolvedRoot, safe);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) return { ok: true, path: target, existing: true, name: safe };
    } catch {}
    try {
      await execFile(git, ["-C", repo, "worktree", "add", "-b", `melon/${safe}`, target, base], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, path: target, existing: false, name: safe };
    } catch (err) {
      throw new Error(String(err.stderr || err.message || err).trim().slice(0, 400));
    }
  }

  async function list() {
    await ensureRoot();
    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(resolvedRoot, entry.name);
      const stat = await fs.stat(target).catch(() => null);
      out.push({ name: entry.name, path: target, updatedAt: stat?.mtimeMs || null });
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  return { root: resolvedRoot, repo, inside, resolve, validateName, ensureRoot, add, list };
}

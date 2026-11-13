import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorktreeManager } from "../server/worktrees.mjs";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("worktree manager creates isolated branches and rejects escapes", { skip: !hasGit }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-wt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git(["init"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"]);

  const manager = createWorktreeManager({ root: path.join(dir, "worktrees"), repo });
  assert.equal(manager.inside(manager.root), true);
  assert.equal(manager.inside(path.join(dir, "elsewhere")), false);
  assert.throws(() => manager.resolve("../escape"), /escapes/);
  assert.throws(() => manager.validateName("../bad"), /alphanumeric/);

  const created = await manager.add({ name: "agent-agy" });
  assert.equal(created.ok, true);
  assert.equal(created.existing, false);
  const stat = await fs.stat(path.join(created.path, ".git"));
  assert.equal(stat.isFile(), true);

  const again = await manager.add({ name: "agent-agy" });
  assert.equal(again.existing, true);
  const list = await manager.list();
  assert.deepEqual(list.map((item) => item.name), ["agent-agy"]);
});

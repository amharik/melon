import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandbox } from "../server/sandbox.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "melon-sandbox-"));
}

function fakeSrt(dir, body = 'shift 2; shift; exec "$@"') {
  const file = path.join(dir, "srt");
  fs.writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "srt-test 1.0"; exit 0; fi
${body}
`,
    { mode: 0o700 },
  );
  return file;
}

test("sandbox settings deny secrets and allow only the worktree plus tmp", () => {
  const sandbox = createSandbox({ mode: "off", root: tempDir() });
  const settings = sandbox.settingsFor("/tmp/melon-worktree");
  assert.deepEqual(settings.network.allowedDomains, []);
  assert.ok(settings.filesystem.allowWrite.includes("/tmp/melon-worktree"));
  assert.ok(settings.filesystem.allowWrite.includes(os.tmpdir()));
  assert.ok(settings.filesystem.denyRead.some((item) => item.endsWith(".ssh")));
  assert.ok(settings.filesystem.denyWrite.some((item) => item.endsWith(".ssh")));
});

test("sandbox wraps commands with generated settings when srt is available", async () => {
  const dir = tempDir();
  const command = fakeSrt(dir);
  const sandbox = createSandbox({ command, root: dir, settingsDir: path.join(dir, "settings") });
  const outcome = await sandbox.run("printf hello", { cwd: dir, timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(outcome.sandbox, "srt");
  assert.equal(outcome.result.stdout, "hello");
  const file = fs.readdirSync(path.join(dir, "settings")).find((name) => name.startsWith("sandbox-"));
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings", file), "utf8"));
  assert.deepEqual(settings.network.allowedDomains, []);
  assert.ok(settings.filesystem.allowWrite.includes(dir));
});

test("sandbox falls back with an audit trail when srt is missing", async () => {
  const sandbox = createSandbox({ command: path.join(tempDir(), "missing-srt"), root: tempDir() });
  const outcome = await sandbox.run("printf fallback", { timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(outcome.sandbox, "none");
  assert.match(outcome.sandboxError, /srt|ENOENT|missing/i);
  assert.equal(outcome.result.stdout, "fallback");
});

test("sandbox required mode fails closed when srt is missing", async () => {
  const sandbox = createSandbox({
    mode: "required",
    command: path.join(tempDir(), "missing-srt"),
    root: tempDir(),
  });
  await assert.rejects(() => sandbox.run("printf nope"), /sandbox required/);
});

test("sandbox propagates command failures without falling back", async () => {
  const dir = tempDir();
  const command = fakeSrt(dir);
  const sandbox = createSandbox({ command, root: dir, settingsDir: path.join(dir, "settings") });
  await assert.rejects(
    () => sandbox.run("exit 7", { cwd: dir, timeout: 10000, maxBuffer: 1024 * 1024 }),
    (err) => err.code === 7 && err.sandbox === "srt",
  );
});

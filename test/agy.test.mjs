import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgyRunner, parseAgyLine, splitArgs } from "../server/agy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "scripts", "fake-agy.mjs");

test("parseAgyLine tolerates common stream shapes", () => {
  assert.deepEqual(parseAgyLine('{"type":"text","text":"hi"}'), { type: "chunk", text: "hi" });
  assert.deepEqual(parseAgyLine('{"type":"delta","delta":"x"}'), { type: "chunk", text: "x" });
  assert.deepEqual(parseAgyLine('{"message":{"content":[{"text":"a"},{"text":"b"}]}}'), {
    type: "chunk",
    text: "ab",
  });
  assert.deepEqual(parseAgyLine('{"type":"done","text":"done"}'), { type: "done", text: "done" });
  assert.deepEqual(parseAgyLine("plain output"), { type: "chunk", text: "plain output\n" });
  assert.deepEqual(parseAgyLine('{"type":"error","error":{"message":"bad"}}'), {
    type: "error",
    message: "bad",
  });
  assert.equal(parseAgyLine(""), null);
  assert.deepEqual(splitArgs('--a "b c" --d'), ["--a", "b c", "--d"]);
});

test("agy runner streams NDJSON from a stdio CLI", async () => {
  const runner = createAgyRunner({
    cmd: process.execPath,
    args: [FAKE],
    inputFormat: "prompt",
  });
  const chunks = [];
  const text = await runner.run({
    prompt: "review the plan",
    cwd: ROOT,
    env: { ...process.env, PATH: process.env.PATH },
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(text, "agy: review the plan");
  assert.deepEqual(chunks, ["agy: ", "review the plan"]);
});

test("agy runner surfaces a non-zero exit", async () => {
  const runner = createAgyRunner({ cmd: process.execPath, args: [FAKE] });
  await assert.rejects(
    runner.run({ prompt: "please FAIL", cwd: ROOT, env: process.env }),
    /requested failure/,
  );
});

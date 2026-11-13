#!/usr/bin/env node
// Test double for AGY_CMD. Speaks the same newline-delimited JSON contract as
// the hub's CLI adapter, without invoking a real coding agent.

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompt = "";
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const data = JSON.parse(trimmed);
    prompt = data.prompt || data.message?.content || data.content || "";
  } catch {
    prompt = trimmed;
  }
}

if (prompt.includes("FAIL")) {
  process.stderr.write("fake agy: requested failure\n");
  process.exit(1);
}

const text = `agy: ${prompt}`;
process.stdout.write(JSON.stringify({ type: "text", text: "agy: " }) + "\n");
process.stdout.write(JSON.stringify({ type: "text", text: prompt }) + "\n");
process.stdout.write(JSON.stringify({ type: "done", text }) + "\n");

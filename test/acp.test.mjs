import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpClient } from "../server/acp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = path.join(ROOT, "test", "fixtures", "acp-agent.mjs");

test("ACP client initializes a session and streams agent text over stdio", async () => {
  const chunks = [];
  const client = createAcpClient({
    command: process.execPath,
    args: [AGENT],
    cwd: ROOT,
    timeoutMs: 10000,
  });
  const text = await client.run("hello from melon", {
    onChunk: (chunk) => chunks.push(chunk),
  });
  client.close();
  assert.equal(text, "echo: hello from melon");
  assert.deepEqual(chunks, ["echo: hello from melon"]);
});

test("ACP client denies permission requests by default", async () => {
  const client = createAcpClient({
    command: process.execPath,
    args: [AGENT],
    cwd: ROOT,
    timeoutMs: 10000,
    onPermission: (params) => {
      assert.equal(params.toolCall?.toolCallId, "permission-1");
      return { outcome: { outcome: "cancelled" } };
    },
  });
  const text = await client.run("permission check");
  client.close();
  assert.equal(text, "echo: permission check");
});

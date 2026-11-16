import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createEmbeddingClient,
  createEmbeddingClientFromEnv,
  hashEmbedding,
  vectorToBlob,
} from "../server/embeddings.mjs";
import { createMessageStore } from "../server/messages.mjs";

function norm(vector) {
  return Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0));
}

test("hashed embeddings are deterministic, normalized, and correctly sized", () => {
  const first = hashEmbedding("SQLite vector similarity search");
  const second = hashEmbedding("SQLite vector similarity search");
  assert.equal(first.length, 256);
  assert.deepEqual(first, second);
  assert.ok(Math.abs(norm(first) - 1) < 1e-6);
  assert.notDeepEqual(first, hashEmbedding("unrelated latency benchmark"));

  const blob = vectorToBlob(first);
  assert.equal(blob.byteLength, 256 * 4);
});

test("embedding provider defaults to the local hash backend", async () => {
  const client = createEmbeddingClientFromEnv({});
  assert.equal(client.provider, "hash");
  assert.equal(client.remote, false);
  const result = await client.embedOne("hello world");
  assert.equal(result.vector.length, 256);
  assert.equal(result.model, "hash-v1");
});

test("OpenAI-compatible embeddings parse data and send the API key", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        });
      },
    };
  };
  const client = createEmbeddingClient({
    provider: "openai",
    url: "http://127.0.0.1:11434/v1/",
    model: "nomic-embed-text",
    key: "secret",
    fetchImpl,
  });
  const result = await client.embed(["alpha", "beta"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/embeddings");
  assert.equal(requests[0].options.headers.authorization, "Bearer secret");
  assert.equal(result.dim, 3);
  assert.deepEqual([...result.vectors[0]], [1, 0, 0]);
  assert.deepEqual([...result.vectors[1]], [0, 1, 0]);
});

test("Ollama embeddings use /api/embed batches", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ embeddings: [[1, 0, 0], [0, 1, 0]] });
      },
    };
  };
  const client = createEmbeddingClient({
    provider: "ollama",
    url: "http://127.0.0.1:11434",
    model: "nomic-embed-text",
    fetchImpl,
  });
  const result = await client.embed(["alpha", "beta"]);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/api/embed");
  assert.equal(result.dim, 3);
  assert.equal(result.vectors.length, 2);
});

test("remote embeddings are written in the background and become searchable", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-embed-store-"));
  const dbPath = path.join(tmpDir, "messages.db");
  const client = {
    provider: "test",
    model: "test-v1",
    dimensions: 3,
    remote: true,
    async embed(texts) {
      return {
        vectors: texts.map((text) =>
          Float32Array.from(text.includes("vector") ? [1, 0, 0] : [0, 1, 0]),
        ),
        model: "test-v1",
        dim: 3,
        provider: "test",
      };
    },
    async embedOne(text) {
      const result = await this.embed([text]);
      return { vector: result.vectors[0], model: "test-v1", dim: 3, provider: "test" };
    },
    embedSync() {
      throw new Error("sync embeddings are not available");
    },
    info() {
      return { provider: "test", model: "test-v1", dimensions: 3, remote: true };
    },
  };

  const store = createMessageStore({ dbPath, embedding: client });
  assert.equal(store.embedding.remote, true);
  store.appendMessage({
    id: "a",
    targetType: "channel",
    targetId: "general-war-room",
    text: "vector indexing notes",
    createdAt: 1000,
  });
  store.appendMessage({
    id: "b",
    targetType: "channel",
    targetId: "general-war-room",
    text: "latency benchmark notes",
    createdAt: 2000,
  });
  assert.equal(store.embedding.pending, 2);

  await store.flushEmbeddings();
  assert.equal(store.embedding.pending, 0);
  assert.equal(store.embedding.failed, 0);
  assert.equal(store.embedding.model, "test-v1");

  const results = await store.searchMessages("vector", { targetType: "channel", targetId: "general-war-room" });
  assert.equal(results[0].id, "a");
  assert.ok(results[0].sources.includes("vector"));

  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("legacy rows are re-embedded with the configured provider", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "melon-embed-legacy-"));
  const dbPath = path.join(tmpDir, "legacy.db");
  const client = {
    provider: "test",
    model: "test-v1",
    dimensions: 2,
    remote: true,
    async embed(texts) {
      return {
        vectors: texts.map(() => Float32Array.from([1, 0])),
        model: "test-v1",
        dim: 2,
        provider: "test",
      };
    },
    async embedOne(text) {
      const result = await this.embed([text]);
      return { vector: result.vectors[0], model: "test-v1", dim: 2, provider: "test" };
    },
    embedSync() {
      throw new Error("sync embeddings are not available");
    },
    info() {
      return { provider: "test", model: "test-v1", dimensions: 2, remote: true };
    },
  };

  const store = createMessageStore({ dbPath, embedding: client });
  store.appendMessage({ id: "legacy", text: "legacy row", createdAt: 1000 });
  await store.flushEmbeddings();
  assert.equal(store.embedding.pending, 0);

  const row = store.getMessages("channel", "general-war-room")[0];
  assert.equal(row.id, "legacy");
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

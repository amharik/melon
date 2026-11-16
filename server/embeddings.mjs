// Local embedding providers for team-chat search.
//
// Default is a deterministic 256-dimension hashed bag-of-words vector, which
// keeps Melon usable with no model server. Set EMBEDDING_URL + EMBEDDING_MODEL
// for an OpenAI-compatible /embeddings endpoint, or OLLAMA_EMBED_MODEL for
// Ollama. Remote calls never block message writes: the store marks rows pending
// and embeds them in the background.

import crypto from "node:crypto";

const HASH_DIMENSIONS = 256;
const DEFAULT_BATCH = 16;
const MAX_BATCH = 64;
const CACHE_LIMIT = 512;

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/g, "");
}

function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashEmbedding(text, dimensions = HASH_DIMENSIONS) {
  const dim = Math.max(8, Math.min(4096, Math.trunc(Number(dimensions) || HASH_DIMENSIONS)));
  const vector = new Float32Array(dim);
  const tokens =
    cleanText(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) || [];
  for (const token of tokens) {
    if (token.length < 2) continue;
    const bucket = fnv1a(token) % dim;
    const sign = fnv1a(token, 0x9e3779b9) & 1 ? 1 : -1;
    vector[bucket] += sign * (1 + Math.log(1 + token.length));
  }
  return normalizeVector(vector);
}

export function normalizeVector(vector) {
  const out = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  let norm = 0;
  for (let index = 0; index < out.length; index += 1) {
    const value = Number(out[index]) || 0;
    out[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < out.length; index += 1) out[index] /= norm;
  return out;
}

export function vectorToBlob(vector) {
  const out = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(ms) || 15000));
  return { controller, timer };
}

function assertVectors(vectors, expected, label) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(`${label} returned ${vectors?.length ?? 0} vectors for ${expected} inputs`);
  }
  let dimensions = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
      throw new Error(`${label} returned a non-vector value`);
    }
    const size = /** @type {{ length: number }} */ (vector).length;
    if (!dimensions) dimensions = size;
    if (size !== dimensions) throw new Error(`${label} returned inconsistent dimensions`);
  }
  return dimensions;
}

export function createEmbeddingClient({
  provider = "hash",
  url = "",
  model = "",
  key = "",
  dimensions = null,
  batchSize = DEFAULT_BATCH,
  timeoutMs = 15000,
  fetchImpl = fetch,
} = {}) {
  const selected = String(provider || "hash").toLowerCase();
  const base = String(url || "")
    .trim()
    .replace(/\/+$/, "");
  const selectedModel = selected === "hash" ? "hash-v1" : String(model || "").trim();
  const selectedDimensions =
    selected === "hash"
      ? Math.max(8, Math.min(4096, Math.trunc(Number(dimensions) || HASH_DIMENSIONS)))
      : Math.max(0, Math.trunc(Number(dimensions) || 0));
  let resolvedDimensions = selectedDimensions;
  const batch = Math.max(1, Math.min(MAX_BATCH, Math.trunc(Number(batchSize) || DEFAULT_BATCH)));
  const cache = new Map();

  if (selected !== "hash" && !base) throw new Error(`${selected} embeddings require a URL`);
  if (selected !== "hash" && !selectedModel) throw new Error(`${selected} embeddings require a model`);

  function cacheGet(text) {
    if (selected === "hash") return null;
    const key = `${selectedModel}:${sha256(text)}`;
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  function cacheSet(text, vector) {
    if (selected === "hash") return;
    const key = `${selectedModel}:${sha256(text)}`;
    cache.set(key, vector);
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
  }

  function embedSync(text) {
    if (selected !== "hash") throw new Error("sync embeddings are only available for the hash provider");
    return {
      vector: hashEmbedding(text, selectedDimensions),
      model: selectedModel,
      dim: selectedDimensions,
      provider: selected,
    };
  }

  async function openAiBatch(texts) {
    const endpoint = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const { controller, timer } = timeoutSignal(timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: selectedModel, input: texts }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("embedding request timed out");
      throw new Error(`embedding request failed: ${String(err?.message || err).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`embedding endpoint ${response.status}: ${String(text || "").slice(0, 200)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("embedding endpoint returned invalid JSON");
    }
    let vectors;
    if (Array.isArray(data.data)) {
      const items = [...data.data].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
      vectors = items.map((item) => item.embedding);
    } else if (Array.isArray(data.embeddings)) {
      vectors = data.embeddings;
    } else if (Array.isArray(data.vectors)) {
      vectors = data.vectors;
    }
    const dim = assertVectors(vectors, texts.length, "embedding endpoint");
    return { vectors: vectors.map(normalizeVector), dim };
  }

  async function ollamaBatch(texts) {
    const endpoint = base.endsWith("/api/embed") ? base : `${base}/api/embed`;
    const { controller, timer } = timeoutSignal(timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: selectedModel, input: texts }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("embedding request timed out");
      throw new Error(`embedding request failed: ${String(err?.message || err).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Older Ollama releases do not implement /api/embed; fall back to one at a time.
      return ollamaOneByOne(texts);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Ollama returned invalid JSON");
    }
    const vectors = data.embeddings;
    const dim = assertVectors(vectors, texts.length, "Ollama");
    return { vectors: vectors.map(normalizeVector), dim };
  }

  async function ollamaOneByOne(texts) {
    const endpoint = base.endsWith("/api/embeddings") ? base : `${base}/api/embeddings`;
    const vectors = [];
    let dim = 0;
    for (const input of texts) {
      const { controller, timer } = timeoutSignal(timeoutMs);
      let response;
      let text;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: selectedModel, prompt: input }),
          signal: controller.signal,
        });
        text = await response.text();
      } catch (err) {
        if (err?.name === "AbortError") throw new Error("embedding request timed out");
        throw new Error(`embedding request failed: ${String(err?.message || err).slice(0, 200)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        throw new Error(`Ollama embedding endpoint ${response.status}: ${String(text || "").slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Ollama returned invalid JSON");
      }
      if (!Array.isArray(data.embedding)) throw new Error("Ollama returned no embedding");
      dim = data.embedding.length;
      vectors.push(normalizeVector(data.embedding));
    }
    return { vectors, dim };
  }

  async function embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map(cleanText);
    if (!list.length)
      return { vectors: [], model: selectedModel, dim: selectedDimensions, provider: selected };

    if (selected === "hash") {
      return {
        vectors: list.map((text) => hashEmbedding(text, selectedDimensions)),
        model: selectedModel,
        dim: selectedDimensions,
        provider: selected,
      };
    }

    const vectors = [];
    let dim = selectedDimensions;
    for (let index = 0; index < list.length; index += batch) {
      const slice = list.slice(index, index + batch);
      const missing = [];
      const positions = [];
      slice.forEach((text, offset) => {
        const hit = cacheGet(text);
        if (hit) {
          vectors[index + offset] = hit;
        } else {
          missing.push(text);
          positions.push(index + offset);
        }
      });
      if (!missing.length) continue;
      const result = selected === "ollama" ? await ollamaBatch(missing) : await openAiBatch(missing);
      if (!dim && result.dim) dim = result.dim;
      if (result.dim && dim && result.dim !== dim) {
        throw new Error(`embedding dimensions changed from ${dim} to ${result.dim}`);
      }
      result.vectors.forEach((vector, offset) => {
        const position = positions[offset];
        vectors[position] = vector;
        cacheSet(missing[offset], vector);
      });
    }

    const finalDim = dim || vectors[0]?.length || 0;
    if (finalDim) resolvedDimensions = finalDim;
    return { vectors, model: selectedModel, dim: finalDim, provider: selected };
  }

  async function embedOne(text) {
    const result = await embed([text]);
    return {
      vector: result.vectors[0],
      model: result.model,
      dim: result.dim,
      provider: result.provider,
    };
  }

  return {
    provider: selected,
    model: selectedModel,
    dimensions: resolvedDimensions,
    remote: selected !== "hash",
    enabled: true,
    embed,
    embedOne,
    embedSync,
    info() {
      return {
        provider: selected,
        model: selectedModel,
        dimensions: resolvedDimensions,
        remote: selected !== "hash",
      };
    },
  };
}

export function createEmbeddingClientFromEnv(env = process.env) {
  const provider = String(env.EMBEDDING_PROVIDER || "").toLowerCase();
  const timeoutMs = Number(env.EMBEDDING_TIMEOUT_MS) || 15000;

  if (provider === "hash") {
    return createEmbeddingClient({ provider: "hash", timeoutMs });
  }

  if (provider === "openai" || env.EMBEDDING_URL) {
    return createEmbeddingClient({
      provider: "openai",
      url: env.EMBEDDING_URL,
      model: env.EMBEDDING_MODEL,
      key: env.EMBEDDING_KEY,
      dimensions: Number(env.EMBEDDING_DIMENSIONS) || 0,
      timeoutMs,
    });
  }

  if (provider === "ollama" || env.OLLAMA_EMBED_MODEL) {
    return createEmbeddingClient({
      provider: "ollama",
      url: env.OLLAMA_URL || "http://127.0.0.1:11434",
      model: env.OLLAMA_EMBED_MODEL || env.EMBEDDING_MODEL,
      dimensions: Number(env.EMBEDDING_DIMENSIONS) || 0,
      timeoutMs,
    });
  }

  return createEmbeddingClient({ provider: "hash", timeoutMs });
}

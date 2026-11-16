// Melon Local SQLite & Vector Message Store
// Persists team chat messages, handles erase-back, and tracks persistent
// tab-to-agent identity associations across browser and machine reboots.
//
// The store uses Node's built-in SQLite driver (Node 24+) with FTS5 for lexical
// search and a pluggable embedding client for semantic search. All SQL is
// parameterized. Remote embeddings are written in the background so message
// writes never wait on a model server.

import crypto from "node:crypto";
import path from "node:path";
import { openDatabase } from "./db.mjs";
import {
  createEmbeddingClient,
  createEmbeddingClientFromEnv,
  hashEmbedding,
  vectorToBlob,
} from "./embeddings.mjs";

const MAX_SEARCH_SCAN = 5000;
const FTS_CANDIDATES = 200;
const RRF_K = 60;
const EMBED_BATCH = 16;
const EMBED_MAX_ATTEMPTS = 3;

function computeEmbeddingVector(text) {
  if (!text) return {};
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const len = Math.sqrt(Object.values(tf).reduce((sum, v) => sum + v * v, 0)) || 1;
  const normalized = {};
  for (const [k, v] of Object.entries(tf)) {
    normalized[k] = parseFloat((v / len).toFixed(4));
  }
  return normalized;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  const denseA = ArrayBuffer.isView(vecA) || Array.isArray(vecA);
  const denseB = ArrayBuffer.isView(vecB) || Array.isArray(vecB);
  if (denseA && denseB) {
    const length = Math.min(vecA.length, vecB.length);
    let dot = 0;
    for (let index = 0; index < length; index += 1) {
      dot += Number(vecA[index] || 0) * Number(vecB[index] || 0);
    }
    return dot;
  }
  if (denseA || denseB) return 0;
  let dot = 0;
  for (const [key, value] of Object.entries(vecA)) {
    if (vecB[key]) dot += value * vecB[key];
  }
  return dot;
}

function parseEmbedding(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return new Float32Array(bytes.buffer);
  }
  if (Array.isArray(value)) return Float32Array.from(value);
  return null;
}

function ftsQuery(query) {
  const tokens =
    String(query || "")
      .toLowerCase()
      .match(/[a-z0-9_]+/g) || [];
  const unique = [...new Set(tokens.filter((token) => token.length > 1))].slice(0, 32);
  if (!unique.length) return null;
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}

function contentHash(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""))
    .digest("hex");
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        target_type TEXT,
        target_id TEXT,
        author TEXT,
        avatar TEXT,
        tag TEXT,
        time TEXT,
        text TEXT,
        is_user INTEGER,
        created_at INTEGER,
        embedding TEXT,
        embedding_blob BLOB,
        embedding_model TEXT,
        embedding_dim INTEGER,
        embedding_status TEXT DEFAULT 'ready',
        embedding_attempts INTEGER DEFAULT 0,
        embedding_error TEXT,
        content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_type, target_id, created_at);

      CREATE TABLE IF NOT EXISTS persistent_agents (
        handle TEXT PRIMARY KEY,
        quirky TEXT,
        category TEXT,
        role TEXT,
        persona TEXT,
        avatar TEXT,
        urls TEXT,
        last_tab_id INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);

    addColumnIfMissing(db, "messages", "embedding_blob", "BLOB");
    addColumnIfMissing(db, "messages", "embedding_model", "TEXT");
    addColumnIfMissing(db, "messages", "embedding_dim", "INTEGER");
    addColumnIfMissing(db, "messages", "embedding_status", "TEXT DEFAULT 'ready'");
    addColumnIfMissing(db, "messages", "embedding_attempts", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "messages", "embedding_error", "TEXT");
    addColumnIfMissing(db, "messages", "content_hash", "TEXT");

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
    `);
  },
  (db) => {
    addColumnIfMissing(db, "messages", "embedding_attempts", "INTEGER DEFAULT 0");
    addColumnIfMissing(db, "messages", "embedding_error", "TEXT");
    db.exec(`
      UPDATE messages
      SET embedding_status = CASE
        WHEN text IS NULL OR trim(text) = '' THEN 'ready'
        ELSE 'pending'
      END
      WHERE embedding_blob IS NULL;
    `);
  },
];

function normalizeClient(client) {
  const remote =
    typeof client?.remote === "boolean" ? client.remote : String(client?.provider || "hash") !== "hash";
  return {
    client,
    remote,
    provider: String(client?.provider || (remote ? "unknown" : "hash")),
    model: String(client?.model || (remote ? "unknown" : "hash-v1")),
    dimensions: Number(client?.dimensions) || 0,
  };
}

export function createMessageStore({
  dbPath = path.resolve(process.cwd(), ".melon/messages.db"),
  embedding = null,
  embeddingEnv = process.env,
} = {}) {
  let lastError = null;
  let connection = null;
  let embeddingClient;
  let embeddingError = null;
  let embeddingTimer = null;
  let embeddingBusy = false;
  let embeddingBackoff = 0;
  let closed = false;

  try {
    embeddingClient = embedding || createEmbeddingClientFromEnv(embeddingEnv);
  } catch (err) {
    embeddingError = err;
    embeddingClient = createEmbeddingClient({ provider: "hash" });
  }
  const embeddingMeta = normalizeClient(embeddingClient);

  if (!embeddingClient || typeof embeddingClient.embed !== "function") {
    embeddingError = new Error("embedding client is missing embed()");
    embeddingClient = createEmbeddingClient({ provider: "hash" });
  }

  try {
    connection = openDatabase({ file: dbPath });
    connection.migrate(MIGRATIONS);
  } catch (err) {
    lastError = err;
    try {
      connection?.close();
    } catch {}
    connection = null;
  }

  function ensure() {
    if (!connection) throw lastError || new Error("message store unavailable");
    return connection.db;
  }

  function pendingCount() {
    if (!connection) return 0;
    try {
      return Number(
        connection.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE embedding_status = 'pending'").get()
          ?.n || 0,
      );
    } catch {
      return 0;
    }
  }

  function failedCount() {
    if (!connection) return 0;
    try {
      return Number(
        connection.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE embedding_status = 'error'").get()
          ?.n || 0,
      );
    } catch {
      return 0;
    }
  }

  function scheduleEmbedding(delay = 0) {
    if (closed || !connection || embeddingTimer) return;
    embeddingTimer = setTimeout(
      () => {
        embeddingTimer = null;
        void processPending();
      },
      Math.max(0, Number(delay) || 0),
    );
    embeddingTimer.unref?.();
  }

  async function processPending() {
    if (closed || !connection || embeddingBusy) return;
    embeddingBusy = true;
    let rows = [];
    try {
      rows = connection.db
        .prepare(
          `SELECT id, text, embedding_attempts
           FROM messages
           WHERE embedding_status = 'pending' AND embedding_attempts < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(EMBED_MAX_ATTEMPTS, EMBED_BATCH);
      if (!rows.length) {
        embeddingBackoff = 0;
        return;
      }

      const result = await embeddingClient.embed(rows.map((row) => row.text || ""));
      const vectors = result?.vectors;
      if (!Array.isArray(vectors) || vectors.length !== rows.length) {
        throw new Error("embedding client returned an unexpected number of vectors");
      }

      const update = connection.db.prepare(
        `UPDATE messages
         SET embedding_blob = ?, embedding_model = ?, embedding_dim = ?,
             embedding_status = 'ready', embedding_attempts = 0, embedding_error = NULL
         WHERE id = ?`,
      );
      const fail = connection.db.prepare(
        `UPDATE messages
         SET embedding_attempts = embedding_attempts + 1,
             embedding_status = CASE
               WHEN embedding_attempts + 1 >= ? THEN 'error'
               ELSE 'pending'
             END,
             embedding_error = ?
         WHERE id = ?`,
      );

      connection.transaction(() => {
        rows.forEach((row, index) => {
          const vector = vectors[index];
          if (!vector || !vector.length) {
            fail.run(EMBED_MAX_ATTEMPTS, "empty embedding vector", row.id);
            return;
          }
          update.run(
            vectorToBlob(vector),
            String(result.model || embeddingMeta.model),
            Number(result.dim || vector.length),
            row.id,
          );
        });
      });

      embeddingError = null;
      embeddingBackoff = 0;
    } catch (err) {
      embeddingError = err;
      const message = String(err?.message || err).slice(0, 500);
      if (rows.length) {
        try {
          const fail = connection.db.prepare(
            `UPDATE messages
             SET embedding_attempts = embedding_attempts + 1,
                 embedding_status = CASE
                   WHEN embedding_attempts + 1 >= ? THEN 'error'
                   ELSE 'pending'
                 END,
                 embedding_error = ?
             WHERE id = ?`,
          );
          connection.transaction(() => {
            for (const row of rows) fail.run(EMBED_MAX_ATTEMPTS, message, row.id);
          });
        } catch {}
      }
      embeddingBackoff = Math.min(60000, Math.max(1000, embeddingBackoff ? embeddingBackoff * 2 : 1000));
    } finally {
      embeddingBusy = false;
      if (!closed && connection) {
        if (pendingCount() > 0) scheduleEmbedding(embeddingBackoff || 1000);
        else embeddingBackoff = 0;
      }
    }
  }

  async function flushEmbeddings({ maxBatches = 50 } = {}) {
    if (embeddingTimer) {
      clearTimeout(embeddingTimer);
      embeddingTimer = null;
    }
    for (let index = 0; index < maxBatches && connection && !closed; index += 1) {
      if (embeddingBusy) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        index -= 1;
        continue;
      }
      const before = pendingCount();
      if (!before) break;
      await processPending();
      if (pendingCount() >= before) break;
    }
    if (embeddingTimer) {
      clearTimeout(embeddingTimer);
      embeddingTimer = null;
    }
  }

  function appendMessage(msg = {}) {
    const store = ensure();
    const id = String(msg.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const targetType = String(msg.targetType || "channel");
    const targetId = String(msg.targetId || "general-war-room");
    const author = String(msg.author || "User");
    const avatar = String(msg.avatar || "💬");
    const tag = String(msg.tag || "MSG");
    const time = String(
      msg.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
    const text = String(msg.text || "");
    const isUser = msg.isUser ? 1 : 0;
    const createdAt = Number.isFinite(Number(msg.createdAt)) ? Number(msg.createdAt) : Date.now();
    const hash = contentHash(text);

    let embeddingBlob = null;
    let embeddingModel = null;
    let embeddingDim = 0;
    let embeddingStatus = text ? "pending" : "ready";

    if (!embeddingMeta.remote && text) {
      try {
        const result = embeddingClient.embedSync(text);
        if (result?.vector?.length) {
          embeddingBlob = vectorToBlob(result.vector);
          embeddingModel = String(result.model || embeddingMeta.model);
          embeddingDim = Number(result.dim || result.vector.length);
          embeddingStatus = "ready";
        }
      } catch (err) {
        embeddingError = err;
      }
    }

    store
      .prepare(
        `INSERT INTO messages (
           id, target_type, target_id, author, avatar, tag, time, text, is_user,
           created_at, embedding, embedding_blob, embedding_model, embedding_dim,
           embedding_status, embedding_attempts, embedding_error, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           target_type = excluded.target_type,
           target_id = excluded.target_id,
           author = excluded.author,
           avatar = excluded.avatar,
           tag = excluded.tag,
           time = excluded.time,
           text = excluded.text,
           is_user = excluded.is_user,
           created_at = excluded.created_at,
           embedding = excluded.embedding,
           embedding_blob = excluded.embedding_blob,
           embedding_model = excluded.embedding_model,
           embedding_dim = excluded.embedding_dim,
           embedding_status = excluded.embedding_status,
           embedding_attempts = excluded.embedding_attempts,
           embedding_error = excluded.embedding_error,
           content_hash = excluded.content_hash`,
      )
      .run(
        id,
        targetType,
        targetId,
        author,
        avatar,
        tag,
        time,
        text,
        isUser,
        createdAt,
        null,
        embeddingBlob,
        embeddingModel,
        embeddingDim,
        embeddingStatus,
        hash,
      );

    if (embeddingStatus === "pending") scheduleEmbedding(0);

    return {
      id,
      targetType,
      targetId,
      author,
      avatar,
      tag,
      time,
      text,
      isUser: Boolean(isUser),
      createdAt,
    };
  }

  function getMessages(targetType, targetId, { limit = 50, before = null } = {}) {
    const store = ensure();
    const lim = Math.max(1, Math.min(Number(limit) || 50, 500));
    const params = [String(targetType), String(targetId)];
    let sql = `
      SELECT id, target_type as targetType, target_id as targetId, author, avatar,
             tag, time, text, is_user, created_at as createdAt
      FROM messages
      WHERE target_type = ? AND target_id = ?`;
    const beforeValue = Number(before);
    if (before !== null && before !== undefined && Number.isFinite(beforeValue)) {
      sql += " AND created_at < ?";
      params.push(beforeValue);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(lim);

    const rows = store.prepare(sql).all(...params);
    rows.reverse();
    return rows.map((row) => ({
      ...row,
      isUser: Boolean(row.is_user),
    }));
  }

  function eraseMessages(targetType, targetId, { count = null } = {}) {
    const store = ensure();
    const type = String(targetType);
    const id = String(targetId);
    if (count !== null && Number(count) > 0) {
      const num = Math.max(1, Math.min(Math.trunc(Number(count)), 100000));
      const result = store
        .prepare(
          `DELETE FROM messages
           WHERE id IN (
             SELECT id FROM messages
             WHERE target_type = ? AND target_id = ?
             ORDER BY created_at DESC
             LIMIT ?
           )`,
        )
        .run(type, id, num);
      return { erasedCount: result.changes };
    }

    const result = store
      .prepare("DELETE FROM messages WHERE target_type = ? AND target_id = ?")
      .run(type, id);
    return { erasedAll: true, erasedCount: result.changes };
  }

  function deleteSingleMessage(msgId) {
    const store = ensure();
    store.prepare("DELETE FROM messages WHERE id = ?").run(String(msgId));
    return { ok: true, deleted: String(msgId) };
  }

  async function searchMessages(query, { targetType = null, targetId = null, topK = 10 } = {}) {
    const store = ensure();
    const limit = Math.max(1, Math.min(Number(topK) || 10, 50));
    const fused = new Map();
    const textual = ftsQuery(query);

    if (textual) {
      const params = [textual];
      let sql = `
        SELECT m.id, m.target_type as targetType, m.target_id as targetId, m.author,
               m.text, m.created_at as createdAt, bm25(messages_fts) AS rank
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ?`;
      if (targetType) {
        sql += " AND m.target_type = ?";
        params.push(String(targetType));
      }
      if (targetId) {
        sql += " AND m.target_id = ?";
        params.push(String(targetId));
      }
      sql += " ORDER BY rank LIMIT ?";
      params.push(FTS_CANDIDATES);

      const rows = store.prepare(sql).all(...params);
      rows.forEach((row, index) => {
        fused.set(row.id, {
          id: row.id,
          targetType: row.targetType,
          targetId: row.targetId,
          author: row.author,
          text: row.text,
          createdAt: row.createdAt,
          score: 1 / (RRF_K + index + 1),
          sources: ["fts"],
        });
      });
    }

    let queryEmbedding = null;
    if (String(query || "").trim()) {
      try {
        queryEmbedding = await embeddingClient.embedOne(query);
      } catch (err) {
        embeddingError = err;
      }
    }

    if (queryEmbedding?.vector?.length) {
      const params = [];
      let sql = `
        SELECT id, target_type as targetType, target_id as targetId, author, text,
               created_at as createdAt, embedding, embedding_blob, embedding_model, embedding_dim
        FROM messages
        WHERE (embedding IS NOT NULL OR embedding_blob IS NOT NULL)`;
      if (targetType) {
        sql += " AND target_type = ?";
        params.push(String(targetType));
      }
      if (targetId) {
        sql += " AND target_id = ?";
        params.push(String(targetId));
      }
      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(MAX_SEARCH_SCAN);

      const scored = [];
      for (const row of store.prepare(sql).all(...params)) {
        let vector = parseEmbedding(row.embedding_blob);
        if (vector && row.embedding_model && row.embedding_model !== queryEmbedding.model) continue;
        if (vector && row.embedding_dim && Number(row.embedding_dim) !== Number(queryEmbedding.dim)) continue;
        if (!vector) {
          if (queryEmbedding.provider !== "hash") continue;
          vector = hashEmbedding(row.text, queryEmbedding.dim);
        }
        const similarity = cosineSimilarity(queryEmbedding.vector, vector);
        if (similarity > 0.05) scored.push({ ...row, similarity });
      }
      scored.sort((a, b) => b.similarity - a.similarity);

      scored.slice(0, FTS_CANDIDATES).forEach((row, index) => {
        const existing = fused.get(row.id);
        const contribution = 1 / (RRF_K + index + 1);
        if (existing) {
          existing.score += contribution;
          existing.sources.push("vector");
          existing.similarity = row.similarity;
        } else {
          fused.set(row.id, {
            id: row.id,
            targetType: row.targetType,
            targetId: row.targetId,
            author: row.author,
            text: row.text,
            createdAt: row.createdAt,
            score: contribution,
            sources: ["vector"],
            similarity: row.similarity,
          });
        }
      });
    }

    return [...fused.values()]
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        author: item.author,
        text: item.text,
        createdAt: item.createdAt,
        score: Number(item.score.toFixed(6)),
        sources: item.sources,
        ...(item.similarity === undefined ? {} : { similarity: Number(item.similarity.toFixed(6)) }),
      }));
  }

  /* -------------------------------- Persistent Tab-to-Agent Associations */

  function getPersistentAgents() {
    const store = ensure();
    const rows = store.prepare("SELECT * FROM persistent_agents ORDER BY updated_at DESC").all();
    return rows.map((row) => {
      let urls = [];
      try {
        const parsed = JSON.parse(row.urls || "[]");
        if (Array.isArray(parsed)) urls = parsed;
      } catch {}
      return {
        handle: row.handle,
        quirky: row.quirky,
        category: row.category,
        role: row.role,
        persona: row.persona,
        avatar: row.avatar,
        urls,
        lastTabId: row.last_tab_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  function savePersistentAgent(agent = {}) {
    const store = ensure();
    const handle = String(agent.handle || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (!handle) return null;

    const quirky = String(agent.quirky || handle.split("-")[0]);
    const category = String(agent.category || handle.split("-")[1] || "web");
    const role = String(agent.role || "Specialist Agent");
    const persona = String(agent.persona || "");
    const avatar = String(agent.avatar || "🤖");
    const urls = JSON.stringify(Array.isArray(agent.urls) ? agent.urls : [agent.url].filter(Boolean));
    const lastTabId = agent.tabId ? Number(agent.tabId) : null;
    const now = Date.now();

    store
      .prepare(
        `INSERT INTO persistent_agents (
           handle, quirky, category, role, persona, avatar, urls, last_tab_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           quirky = excluded.quirky,
           category = excluded.category,
           role = excluded.role,
           persona = excluded.persona,
           avatar = excluded.avatar,
           urls = excluded.urls,
           last_tab_id = excluded.last_tab_id,
           updated_at = excluded.updated_at`,
      )
      .run(handle, quirky, category, role, persona, avatar, urls, lastTabId, now, now);

    return {
      handle,
      quirky,
      category,
      role,
      persona,
      avatar,
      urls: JSON.parse(urls),
      lastTabId,
      updatedAt: now,
    };
  }

  function matchTabToPersistentAgent(tab = {}) {
    const agents = getPersistentAgents();
    const tabUrl = String(tab.url || "").trim();
    const adapter = String(tab.adapter || "auto").toLowerCase();

    // 1. Exact URL match in known URLs list
    if (tabUrl) {
      const exactMatch = agents.find((a) => a.urls.some((u) => u === tabUrl || tabUrl.startsWith(u)));
      if (exactMatch) {
        exactMatch.lastTabId = tab.id;
        savePersistentAgent(exactMatch);
        return exactMatch;
      }
    }

    // 2. Same category / adapter match
    const categoryMatch = agents.find((a) => {
      if (adapter.includes(a.category)) return true;
      if (
        a.urls.some((u) => {
          try {
            return new URL(u).hostname === new URL(tabUrl).hostname;
          } catch {
            return false;
          }
        })
      )
        return true;
      return false;
    });

    if (categoryMatch) {
      if (tabUrl && !categoryMatch.urls.includes(tabUrl)) {
        categoryMatch.urls.push(tabUrl);
      }
      categoryMatch.lastTabId = tab.id;
      savePersistentAgent(categoryMatch);
      return categoryMatch;
    }

    return null;
  }

  function close() {
    closed = true;
    if (embeddingTimer) {
      clearTimeout(embeddingTimer);
      embeddingTimer = null;
    }
    if (!connection) return;
    try {
      connection.close();
    } finally {
      connection = null;
    }
  }

  if (connection) scheduleEmbedding(0);

  return {
    appendMessage,
    getMessages,
    eraseMessages,
    deleteSingleMessage,
    searchMessages,
    flushEmbeddings,
    getPersistentAgents,
    savePersistentAgent,
    matchTabToPersistentAgent,
    computeEmbeddingVector,
    cosineSimilarity,
    close,
    get available() {
      return connection !== null && lastError === null;
    },
    get error() {
      return lastError ? String(lastError.message || lastError) : null;
    },
    get embedding() {
      const info =
        typeof embeddingClient?.info === "function"
          ? embeddingClient.info()
          : {
              provider: embeddingMeta.provider,
              model: embeddingMeta.model,
              dimensions: embeddingMeta.dimensions,
              remote: embeddingMeta.remote,
            };
      return {
        ...info,
        pending: pendingCount(),
        failed: failedCount(),
        error: embeddingError ? String(embeddingError.message || embeddingError) : null,
      };
    },
  };
}

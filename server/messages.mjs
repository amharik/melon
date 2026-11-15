// Melon Local SQLite & Vector Message Store
// Persists team chat messages, handles erase-back, and tracks persistent
// tab-to-agent identity associations across browser and machine reboots.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  let dot = 0;
  for (const [k, v] of Object.entries(vecA)) {
    if (vecB[k]) dot += v * vecB[k];
  }
  return dot;
}

export function createMessageStore({
  dbPath = path.resolve(process.cwd(), ".melon/messages.db"),
  sqliteBin = "sqlite3",
} = {}) {
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  } catch {}

  function runSql(sql, asJson = true) {
    try {
      const args = asJson ? ["-json", dbPath, sql] : [dbPath, sql];
      const stdout = execFileSync(sqliteBin, args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (asJson) {
        const trimmed = stdout.trim();
        return trimmed ? JSON.parse(trimmed) : [];
      }
      return stdout;
    } catch (err) {
      return asJson ? [] : "";
    }
  }

  function init() {
    const schema = `
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
        embedding TEXT
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
    `;
    runSql(schema, false);
  }

  init();

  function escapeSql(str) {
    if (str === null || str === undefined) return "NULL";
    return `'${String(str).replace(/'/g, "''")}'`;
  }

  function appendMessage(msg = {}) {
    const id = String(msg.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const targetType = String(msg.targetType || "channel");
    const targetId = String(msg.targetId || "general-war-room");
    const author = String(msg.author || "User");
    const avatar = String(msg.avatar || "💬");
    const tag = String(msg.tag || "MSG");
    const time = String(msg.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    const text = String(msg.text || "");
    const isUser = msg.isUser ? 1 : 0;
    const createdAt = Number(msg.createdAt || Date.now());
    const embedding = JSON.stringify(computeEmbeddingVector(text));

    const sql = `
      INSERT OR REPLACE INTO messages (
        id, target_type, target_id, author, avatar, tag, time, text, is_user, created_at, embedding
      ) VALUES (
        ${escapeSql(id)},
        ${escapeSql(targetType)},
        ${escapeSql(targetId)},
        ${escapeSql(author)},
        ${escapeSql(avatar)},
        ${escapeSql(tag)},
        ${escapeSql(time)},
        ${escapeSql(text)},
        ${isUser},
        ${createdAt},
        ${escapeSql(embedding)}
      );
    `;
    runSql(sql, false);

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
    const lim = Math.max(1, Math.min(Number(limit) || 50, 500));
    let sql = `
      SELECT id, target_type as targetType, target_id as targetId, author, avatar, tag, time, text, is_user, created_at as createdAt
      FROM messages
      WHERE target_type = ${escapeSql(targetType)} AND target_id = ${escapeSql(targetId)}
    `;
    if (before) {
      sql += ` AND created_at < ${Number(before)}`;
    }
    sql += ` ORDER BY created_at DESC LIMIT ${lim};`;

    const rows = runSql(sql, true);
    // Return in chronological order
    rows.reverse();
    return rows.map((r) => ({
      ...r,
      isUser: Boolean(r.is_user),
    }));
  }

  function eraseMessages(targetType, targetId, { count = null } = {}) {
    if (count !== null && Number(count) > 0) {
      const num = Number(count);
      const sql = `
        DELETE FROM messages
        WHERE id IN (
          SELECT id FROM messages
          WHERE target_type = ${escapeSql(targetType)} AND target_id = ${escapeSql(targetId)}
          ORDER BY created_at DESC
          LIMIT ${num}
        );
      `;
      runSql(sql, false);
      return { erasedCount: num };
    }

    const sql = `
      DELETE FROM messages
      WHERE target_type = ${escapeSql(targetType)} AND target_id = ${escapeSql(targetId)};
    `;
    runSql(sql, false);
    return { erasedAll: true };
  }

  function deleteSingleMessage(msgId) {
    const sql = `DELETE FROM messages WHERE id = ${escapeSql(msgId)};`;
    runSql(sql, false);
    return { ok: true, deleted: msgId };
  }

  function searchMessages(query, { targetType = null, targetId = null, topK = 10 } = {}) {
    let sql = `SELECT id, target_type as targetType, target_id as targetId, author, text, embedding, created_at as createdAt FROM messages`;
    const conditions = [];
    if (targetType) conditions.push(`target_type = ${escapeSql(targetType)}`);
    if (targetId) conditions.push(`target_id = ${escapeSql(targetId)}`);
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC LIMIT 500;`;

    const rows = runSql(sql, true);
    const queryVec = computeEmbeddingVector(query);

    const scored = rows.map((r) => {
      let vec = {};
      try {
        vec = JSON.parse(r.embedding || "{}");
      } catch {}
      const score = cosineSimilarity(queryVec, vec);
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        author: r.author,
        text: r.text,
        createdAt: r.createdAt,
        score,
      };
    });

    return scored
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(topK) || 10);
  }

  /* -------------------------------- Persistent Tab-to-Agent Associations */

  function getPersistentAgents() {
    const rows = runSql(`SELECT * FROM persistent_agents ORDER BY updated_at DESC;`, true);
    return rows.map((r) => {
      let urls = [];
      try {
        urls = JSON.parse(r.urls || "[]");
      } catch {}
      return {
        handle: r.handle,
        quirky: r.quirky,
        category: r.category,
        role: r.role,
        persona: r.persona,
        avatar: r.avatar,
        urls,
        lastTabId: r.last_tab_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  function savePersistentAgent(agent = {}) {
    const handle = String(agent.handle || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!handle) return null;

    const quirky = String(agent.quirky || handle.split("-")[0]);
    const category = String(agent.category || handle.split("-")[1] || "web");
    const role = String(agent.role || "Specialist Agent");
    const persona = String(agent.persona || "");
    const avatar = String(agent.avatar || "🤖");
    const urls = JSON.stringify(Array.isArray(agent.urls) ? agent.urls : [agent.url].filter(Boolean));
    const lastTabId = agent.tabId ? Number(agent.tabId) : null;
    const now = Date.now();

    const sql = `
      INSERT OR REPLACE INTO persistent_agents (
        handle, quirky, category, role, persona, avatar, urls, last_tab_id, created_at, updated_at
      ) VALUES (
        ${escapeSql(handle)},
        ${escapeSql(quirky)},
        ${escapeSql(category)},
        ${escapeSql(role)},
        ${escapeSql(persona)},
        ${escapeSql(avatar)},
        ${escapeSql(urls)},
        ${lastTabId ? lastTabId : "NULL"},
        COALESCE((SELECT created_at FROM persistent_agents WHERE handle = ${escapeSql(handle)}), ${now}),
        ${now}
      );
    `;
    runSql(sql, false);

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
      if (a.urls.some((u) => {
        try {
          return new URL(u).hostname === new URL(tabUrl).hostname;
        } catch {
          return false;
        }
      })) return true;
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

  return {
    appendMessage,
    getMessages,
    eraseMessages,
    deleteSingleMessage,
    searchMessages,
    getPersistentAgents,
    savePersistentAgent,
    matchTabToPersistentAgent,
    computeEmbeddingVector,
    cosineSimilarity,
  };
}

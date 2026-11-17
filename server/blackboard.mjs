// Shared blackboard. Supports both legacy file-backed readBlackboard and
// channel-scoped in-memory/persisted blackboards for autonomous debates.

import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 64 * 1024;
const channelBlackboards = new Map();

export function readBlackboard({ file } = {}) {
  if (!file) return { ok: false, path: null, text: "", error: "not configured" };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, path: file, text: "", error: "not a file" };
    if (stat.size > MAX_BYTES) return { ok: false, path: file, text: "", error: "file is too large" };
    return {
      ok: true,
      path: path.resolve(file),
      text: fs.readFileSync(file, "utf8"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (err) {
    return { ok: false, path: path.resolve(file), text: "", error: err.code || err.message };
  }
}

export function getChannelBlackboard(channelId) {
  const cid = channelId ? String(channelId).trim() : "general-war-room";
  let board = channelBlackboards.get(cid);
  if (!board) {
    board = {
      channelId: cid,
      topic: "",
      status: "idle",
      round: 0,
      maxRounds: 3,
      participants: [],
      turns: [],
      consensus: "",
      artifacts: [],
      updatedAt: Date.now(),
    };
    channelBlackboards.set(cid, board);
  }
  return { ok: true, blackboard: board };
}

export function updateChannelBlackboard(channelId, data = {}) {
  const cid = channelId ? String(channelId).trim() : "general-war-room";
  const current = getChannelBlackboard(cid).blackboard;
  const updated = {
    ...current,
    ...data,
    channelId: cid,
    updatedAt: Date.now(),
  };
  channelBlackboards.set(cid, updated);
  return { ok: true, blackboard: updated };
}

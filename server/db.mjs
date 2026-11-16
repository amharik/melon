// Local SQLite connection and migration helpers.
//
// The hub uses Node's built-in SQLite driver so local persistence does not
// depend on an external `sqlite3` binary. Keep this module thin: callers own
// their schema and statements, while this file owns connection tuning, file
// permissions, transactions and `PRAGMA user_version` migrations.

import fs from "node:fs";
import path from "node:path";
import * as sqlite from "node:sqlite";

// Node 24 exposes `DatabaseSync`; newer releases may rename it to `Database`.
const Database = sqlite.DatabaseSync || sqlite.Database;

function secureFileMode(file) {
  if (!file || file === ":memory:" || file.startsWith("file::memory:")) return;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(candidate, 0o600);
    } catch {}
  }
}

function assertSafeFile(file) {
  if (!file || file === ":memory:" || file.startsWith("file::memory:")) return;
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("database file must not be a symlink");
  }
  if (!stat.isFile()) {
    throw new Error("database path must be a regular file");
  }
}

export function openDatabase({ file, allowExtension = false, timeout = 5000, defensive = true } = {}) {
  if (!file) throw new Error("database file is required");
  if (!Database) throw new Error("node:sqlite driver unavailable; use Node 24+");
  const memory = file === ":memory:" || file.startsWith("file::memory:");

  if (!memory) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path.dirname(file), 0o700);
    } catch {}
    assertSafeFile(file);
  }

  const db = new Database(file, { allowExtension, timeout, defensive });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  secureFileMode(file);

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  function getUserVersion() {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);
  }

  function setUserVersion(version) {
    const safe = Math.max(0, Math.trunc(Number(version) || 0));
    db.exec(`PRAGMA user_version = ${safe}`);
  }

  function migrate(migrations = []) {
    let version = getUserVersion();
    for (let index = version; index < migrations.length; index += 1) {
      transaction(() => {
        migrations[index](db);
        setUserVersion(index + 1);
      });
      version = index + 1;
    }
    secureFileMode(file);
    return version;
  }

  return {
    db,
    file,
    memory,
    close,
    transaction,
    migrate,
    getUserVersion,
    secureFileMode: () => secureFileMode(file),
  };
}

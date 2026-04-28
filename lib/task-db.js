// SQLite-backed task store. node:sqlite (built-in, v22+).
// Local state layer for `atris task`. TODO.md stays the human-readable
// project board; this store gives agents atomic claims and a compact sync row.
//
// Path: ~/.atris/tasks.db (gitignored, never blobbed). Per-workspace scope via
// workspace_root column. Rows survive across machines only when explicitly
// synced (out of scope for tick 1).

'use strict';

// node:sqlite emits an ExperimentalWarning. Suppress only that exact class by
// monkey-patching process.emit at this narrow filter — other warnings (and
// any pre-existing listeners installed by host code) are untouched.
{
  const originalEmit = process.emit;
  process.emit = function patchedEmit(name, data, ...args) {
    if (name === 'warning' && data && data.name === 'ExperimentalWarning'
        && /SQLite/i.test(data.message || '')) {
      return false;
    }
    return originalEmit.apply(process, [name, data, ...args]);
  };
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.atris', 'tasks.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  tag             TEXT,
  workspace_root  TEXT NOT NULL,
  source_key      TEXT,
  claimed_by      TEXT,
  claimed_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  done_at         INTEGER,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace   ON tasks(workspace_root);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by  ON tasks(claimed_by);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_source ON tasks(workspace_root, source_key)
  WHERE source_key IS NOT NULL;
`;

let _cachedDb = null;
let _cachedPath = null;

function getDbPath() {
  return process.env.ATRIS_TASKS_DB || DEFAULT_DB_PATH;
}

function open(dbPath) {
  const target = dbPath || getDbPath();
  if (_cachedDb && _cachedPath === target) return _cachedDb;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(target);
  // Concurrency: WAL gives readers + one writer concurrency; busy_timeout
  // makes contended writers wait instead of returning SQLITE_BUSY at the
  // C library level. We additionally wrap the setup PRAGMAs + DDL in our
  // own retry — under heavy spawn-storm contention, node:sqlite leaks
  // SQLITE_BUSY past the busy_timeout for `db.exec()` calls.
  withBusyRetry(() => db.exec('PRAGMA journal_mode = WAL'));
  withBusyRetry(() => db.exec('PRAGMA busy_timeout = 30000'));
  withBusyRetry(() => db.exec('PRAGMA foreign_keys = ON'));
  withBusyRetry(() => db.exec(SCHEMA));
  // Schema version. Bump at every additive migration; tick 1 ships at v1.
  // Future migrations read this and apply diffs idempotently.
  withBusyRetry(() => db.exec('PRAGMA user_version = 1'));
  _cachedDb = db;
  _cachedPath = target;
  return db;
}

function close() {
  if (_cachedDb) {
    try { _cachedDb.close(); } catch (_) {}
    _cachedDb = null;
    _cachedPath = null;
  }
}

// 26-char ULID-ish (sortable by time prefix). Crockford-safe alphabet.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newId() {
  const ts = Date.now();
  let head = '';
  let n = ts;
  for (let i = 0; i < 10; i++) {
    head = ULID_ALPHABET[n % 32] + head;
    n = Math.floor(n / 32);
  }
  let tail = '';
  const rand = crypto.randomBytes(10);
  for (let i = 0; i < 16; i++) tail += ULID_ALPHABET[rand[i % rand.length] % 32];
  return head + tail;
}

// Walk up from `start` to find the canonical workspace root. We check for
// .git, then atris/, then .atris/. If none found, fall back to `start`. This
// makes `atris task add` from a subdirectory write the same workspace_root
// as parseTodo() reads from the project's atris/TODO.md.
function findWorkspaceRoot(start) {
  let cur = path.resolve(start || process.cwd());
  // Cap the walk at 32 levels to avoid pathological symlink loops.
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    if (fs.existsSync(path.join(cur, 'atris'))) return cur;
    if (fs.existsSync(path.join(cur, '.atris'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(start || process.cwd());
}

function workspaceRoot(cwd) {
  // Normalize symlinks (notably macOS /tmp → /private/tmp), then walk up to
  // the project root so subdirs and the repo root agree on the same key.
  let target = cwd || process.cwd();
  try { target = fs.realpathSync(target); } catch {}
  return findWorkspaceRoot(target);
}

function normalizeTitle(t) {
  return String(t || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
}

function sourceKey(sourceFile, title) {
  if (!sourceFile) return null;
  // Realpath the source file so symlinked / relative imports collapse to the
  // same key. Falls back to input string when the path doesn't resolve.
  let canonical = sourceFile;
  try { canonical = fs.realpathSync(sourceFile); } catch {}
  const h = crypto.createHash('sha1');
  h.update(`${canonical}${normalizeTitle(title)}`);
  return h.digest('hex');
}

function addTask(db, { title, tag, workspaceRoot: ws, sourceKey: sk, metadata, status, claimedBy }) {
  if (!title || !String(title).trim()) throw new Error('title required');
  const now = Date.now();
  const id = newId();
  const taskStatus = ['open', 'claimed', 'done', 'failed'].includes(status) ? status : 'open';
  const claimedAt = taskStatus === 'claimed' ? now : null;
  // Idempotent on (workspace_root, source_key) when source_key supplied.
  if (sk) {
    const existing = db.prepare(
      'SELECT id FROM tasks WHERE workspace_root = ? AND source_key = ?'
    ).get(ws, sk);
    if (existing) return { id: existing.id, inserted: false };
  }
  withBusyRetry(() => db.prepare(`
    INSERT INTO tasks (id, title, status, tag, workspace_root, source_key,
                       claimed_by, claimed_at, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(title).trim(),
    taskStatus,
    tag || null,
    ws,
    sk || null,
    taskStatus === 'claimed' ? (claimedBy || null) : null,
    claimedAt,
    now,
    now,
    metadata ? JSON.stringify(metadata) : null,
  ));
  return { id, inserted: true };
}

function listTasks(db, { workspaceRoot: ws, status, claimedBy, limit }) {
  const where = [];
  const args = [];
  if (ws) { where.push('workspace_root = ?'); args.push(ws); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (claimedBy) { where.push('claimed_by = ?'); args.push(claimedBy); }
  const sql = `
    SELECT id, title, status, tag, workspace_root, source_key, claimed_by, claimed_at, created_at, updated_at, done_at, metadata
    FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'failed' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      created_at DESC
    ${limit ? 'LIMIT ' + Number(limit) : ''}
  `;
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    metadata: r.metadata ? safeJSON(r.metadata) : null,
  }));
}

// Atomic claim. Returns { claimed: true, row } only if THIS call won the row.
// Race-safe via single UPDATE with WHERE status='open' guard. SQLite serializes
// writes; busy_timeout absorbs contention. Caller must check `.claimed`.
function claimTask(db, { id, claimedBy }) {
  if (!id) throw new Error('id required');
  if (!claimedBy) throw new Error('claimedBy required');
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE tasks
       SET status = 'claimed',
           claimed_by = ?,
           claimed_at = ?,
           updated_at = ?
     WHERE id = ?
       AND status = 'open'
  `);
  const result = withBusyRetry(() => stmt.run(claimedBy, now, now, id));
  if (result.changes === 1) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return { claimed: true, row: { ...row, metadata: row.metadata ? safeJSON(row.metadata) : null } };
  }
  // Either id doesn't exist or status != 'open'. Tell the caller which.
  const row = db.prepare('SELECT id, status, claimed_by FROM tasks WHERE id = ?').get(id);
  if (!row) return { claimed: false, reason: 'not_found' };
  return { claimed: false, reason: 'already_' + row.status, claimed_by: row.claimed_by };
}

function doneTask(db, { id, status }) {
  if (!id) throw new Error('id required');
  const final = status || 'done';
  if (!['done', 'failed'].includes(final)) throw new Error('status must be done|failed');
  const now = Date.now();
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = ?, done_at = ?, updated_at = ?
     WHERE id = ?
       AND status IN ('open', 'claimed')
  `).run(final, now, now, id));
  return { updated: result.changes === 1 };
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Wrap a write op so SQLITE_BUSY (concurrent writers from other processes)
// retries with exponential backoff. busy_timeout pragma alone leaks busy
// errors under spawn-storm contention with node:sqlite (~3% raw lock rate
// observed at 1000 attempts). Total wait ≤ ~6s; well above realistic
// contention windows for our agent fleet.
function withBusyRetry(fn, attempts = 8) {
  let delay = 5;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e && e.message || '');
      const code = e && (e.code || e.errcode);
      const busy = /SQLITE_BUSY|database is locked/i.test(msg) || code === 'SQLITE_BUSY' || code === 5;
      if (!busy) throw e;
      // Sleep synchronously — node:sqlite is sync; matches the rest of the API
      const end = Date.now() + delay + Math.floor(Math.random() * delay);
      while (Date.now() < end) {} // tight loop is fine, delay is small
      delay = Math.min(delay * 2, 500);
    }
  }
  throw lastErr;
}

module.exports = {
  open,
  close,
  getDbPath,
  workspaceRoot,
  sourceKey,
  normalizeTitle,
  addTask,
  listTasks,
  claimTask,
  doneTask,
  newId,
  // Test surface
  _SCHEMA: SCHEMA,
};

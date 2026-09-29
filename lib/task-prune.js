'use strict';

// Remove task rows that test runs wrote into the shared task database.
// A row is test junk only when its project folder sits under a temp
// directory (/tmp, /var/folders, os.tmpdir(), and their /private twins) AND
// that folder is gone from disk. Tests make and remove their temp folders;
// a live checkout under /tmp still exists, so it is never touched. Neither
// is any row with a real project path.
//
// planPrune reads only. applyPrune writes a consistent backup with
// VACUUM INTO, checks it, plans from the backup, then deletes in short
// transactions. Each transaction re-checks every task against the backup
// (same row, same history count, still idle, folder still gone), so nothing
// is removed that the backup does not hold.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { withBusyRetry } = require('./task-db');
const { sleepSync } = require('./sleep-sync');

// A temp task with any activity this recent may belong to a test still running.
const GRACE_MS = 60 * 60 * 1000;
const MAX_ROWS_PER_BATCH = 2000;
const BATCH_PAUSE_MS = 20;
const BUSY_TIMEOUT_MS = 5000;

const NAMED_TEMP_ROOTS = [
  '/tmp', '/private/tmp',
  '/var/tmp', '/private/var/tmp',
  '/var/folders', '/private/var/folders',
];

// History lookups by task id. Each must use the task-id index; a plan on the
// workspace/time index rescans unrelated history under the write lock.
const EVENT_SQL = {
  summary: 'SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM task_events WHERE task_id = ?',
  roots: 'SELECT DISTINCT workspace_root FROM task_events WHERE task_id = ?',
  remove: 'DELETE FROM task_events WHERE task_id = ?',
};
// Same definition lib/task-db.js creates on open.
const TASK_ID_INDEX = 'CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, version)';

const TASK_COLUMNS = 'id, title, status, tag, workspace_root, source_key, claimed_by, claimed_at, created_at, updated_at, done_at, metadata';

function normalizeRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw.startsWith('/') && !/^[A-Za-z]:\//.test(raw)) return null;
  // `.` and `..` can mean something else once a link is in the path; a
  // folder spelled that way is never treated as temp.
  if (raw.split('/').some(part => part === '.' || part === '..')) return null;
  const normal = path.posix.normalize(raw);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

function realKey(key) {
  try { return normalizeRoot(fs.realpathSync(key)); } catch { return null; }
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); } catch { return null; }
}

// A link that is a temp root or sits above one (/tmp, /var, a linked TMPDIR)
// is expected. Any other link in the path means we cannot be sure.
function isExpectedLink(dir, roots) {
  return roots.some(root => root === dir || root.startsWith(`${dir}/`));
}

// The real path of a folder that may be gone: resolve its nearest existing
// ancestor (so /var -> /private/var and a symlinked TMPDIR both line up),
// then put the missing tail back. lstat, not exists: a dangling link is
// something on disk and stops the walk. Null when any other link is in the
// existing part of the path.
function resolvedKey(key, roots) {
  let head = key;
  const tail = [];
  while (head && head !== '/' && !lstatOrNull(head)) {
    tail.unshift(path.posix.basename(head));
    head = path.posix.dirname(head);
  }
  for (let dir = head; dir && dir !== '/'; dir = path.posix.dirname(dir)) {
    const stat = lstatOrNull(dir);
    if (stat && stat.isSymbolicLink() && !isExpectedLink(dir, roots)) return null;
  }
  const real = realKey(head);
  if (!real) return null;
  return tail.length ? path.posix.join(real, ...tail) : real;
}

function safeTmpdir() {
  try { return os.tmpdir(); } catch { return null; }
}

function tempRoots({ tmpdir = safeTmpdir(), named = NAMED_TEMP_ROOTS } = {}) {
  const roots = new Set();
  for (const dir of [...named, tmpdir]) {
    const key = normalizeRoot(dir);
    if (!key || key === '/') continue;
    roots.add(key);
    const real = realKey(key);
    if (real && real !== '/') roots.add(real);
  }
  // Shortest first so a row groups under the broad folder, e.g. /var/folders.
  return [...roots].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function matchRoot(key, roots) {
  for (const root of roots) {
    if (key === root || key.startsWith(`${root}/`)) return root;
  }
  return null;
}

// The temp root a project folder sits under, or null for a real project.
// The spelling alone never decides: the folder's real location (through its
// nearest existing ancestor) must sit under a temp root, so a missing
// /tmp/projects/old-repo where /tmp/projects links to a home folder is real.
// The stored spelling only picks the group label.
function tempPrefixFor(workspaceRoot, roots = tempRoots()) {
  const key = normalizeRoot(workspaceRoot);
  if (!key) return null;
  const resolved = resolvedKey(key, roots);
  if (!resolved) return null;
  const real = matchRoot(resolved, roots);
  if (!real) return null;
  return matchRoot(key, roots) || real;
}

// Only a folder that is clearly missing counts as gone. A permission error
// or anything else odd means we cannot tell, so the row stays.
function folderGone(dir) {
  try {
    fs.lstatSync(dir);
    return false;
  } catch (err) {
    return Boolean(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
  }
}

function makeJudge(roots) {
  const cache = new Map();
  // 'real' | 'exists' | prefix (temp and gone)
  return (root) => {
    if (cache.has(root)) return cache.get(root);
    const prefix = tempPrefixFor(root, roots);
    const verdict = !prefix ? 'real' : (folderGone(root) ? prefix : 'exists');
    cache.set(root, verdict);
    return verdict;
  };
}

function isJunk(verdict) {
  return verdict !== 'real' && verdict !== 'exists';
}

function fingerprint(row) {
  return crypto.createHash('sha1').update(JSON.stringify(TASK_COLUMNS.split(', ').map(col => row[col]))).digest('hex');
}

// Stream rows where node:sqlite supports it; older builds only have all().
function eachRow(stmt) {
  return typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all();
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function dbBytes(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try { total += fs.statSync(dbPath + suffix).size; } catch { /* missing wal is fine */ }
  }
  return total;
}

function openReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

// Read-only. Works on the live database or on a backup.
function planPrune(db, { now = Date.now(), graceMs = GRACE_MS, roots = tempRoots() } = {}) {
  const cutoff = now - graceMs;
  const judge = makeJudge(roots);

  // History per task: row count, newest row, and every folder it names.
  const history = new Map();
  for (const row of eachRow(db.prepare(`
    SELECT task_id, workspace_root, COUNT(*) AS n, MAX(created_at) AS last_at
    FROM task_events GROUP BY task_id, workspace_root
  `))) {
    const entry = history.get(row.task_id) || { n: 0, last_at: 0, roots: [] };
    entry.n += Number(row.n);
    entry.last_at = Math.max(entry.last_at, Number(row.last_at) || 0);
    entry.roots.push(row.workspace_root);
    history.set(row.task_id, entry);
  }
  const allJunk = (entry) => entry.roots.every(root => isJunk(judge(root)));

  const usesByTask = new Map();
  if (tableExists(db, 'part_uses')) {
    for (const row of db.prepare('SELECT used_by, COUNT(*) AS n FROM part_uses WHERE used_by IS NOT NULL GROUP BY used_by').all()) {
      usesByTask.set(row.used_by, Number(row.n));
    }
  }

  const groups = new Map();
  const group = (prefix) => {
    if (!groups.has(prefix)) groups.set(prefix, { prefix, tasks: 0, history_rows: 0, stray_history_rows: 0, part_uses: 0 });
    return groups.get(prefix);
  };
  const rows = [];
  const kept = { recent: 0, held: 0, folder_exists: 0, stray_held: 0, stray_recent: 0 };
  let totalTasks = 0;
  for (const row of eachRow(db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks`))) {
    totalTasks += 1;
    const entry = history.get(row.id) || { n: 0, last_at: 0, roots: [] };
    history.delete(row.id);
    const verdict = judge(row.workspace_root);
    if (verdict === 'real') continue;
    if (verdict === 'exists') { kept.folder_exists += 1; continue; }
    if (!allJunk(entry)) { kept.held += 1; continue; }
    if (Math.max(Number(row.updated_at) || 0, entry.last_at) >= cutoff) { kept.recent += 1; continue; }
    const g = group(verdict);
    const uses = usesByTask.get(row.id) || 0;
    g.tasks += 1;
    g.history_rows += entry.n;
    g.part_uses += uses;
    rows.push({ kind: 'task', id: row.id, workspace_root: row.workspace_root, fp: fingerprint(row), events: entry.n, uses });
  }

  // What is left in history has no task row. Only temp-and-gone history is
  // eligible, and a missing task keeps all of its history if any row names
  // a real project or a folder that still exists.
  for (const [taskId, entry] of history) {
    const verdicts = entry.roots.map(judge);
    if (!verdicts.some(isJunk)) continue;
    if (!verdicts.every(isJunk)) { kept.stray_held += 1; continue; }
    if (entry.last_at >= cutoff) { kept.stray_recent += 1; continue; }
    group(verdicts[0]).stray_history_rows += entry.n;
    rows.push({ kind: 'stray', id: taskId, events: entry.n, uses: 0 });
  }

  const list = [...groups.values()].sort((a, b) => b.tasks - a.tasks || a.prefix.localeCompare(b.prefix));
  const sum = (field) => list.reduce((acc, g) => acc + g[field], 0);
  return {
    total_tasks: totalTasks,
    grace_hours: graceMs / (60 * 60 * 1000),
    groups: list,
    remove: {
      tasks: sum('tasks'),
      history_rows: sum('history_rows'),
      stray_history_rows: sum('stray_history_rows'),
      part_uses: sum('part_uses'),
    },
    kept,
    rows,
  };
}

function dryRun(dbPath, options = {}) {
  if (!fs.existsSync(dbPath)) return { db_path: dbPath, missing: true };
  const db = openReadOnly(dbPath);
  try {
    const plan = planPrune(db, options);
    return { db_path: dbPath, db_bytes: dbBytes(dbPath), ...plan };
  } finally {
    db.close();
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function countTasks(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n);
}

function usesTaskIdIndex(db) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${EVENT_SQL.summary}`).all('x').map(r => r.detail).join(' ');
  return /USING (COVERING )?INDEX \S+ \(task_id=\?/.test(plan);
}

// Consistent copy while other processes write: VACUUM INTO reads one
// snapshot. A raw file copy of a live WAL database can tear.
function writeBackup(db, dbPath, now, roots) {
  let backupPath = `${dbPath}.before-prune-${stamp(now)}`;
  for (let i = 2; fs.existsSync(backupPath); i++) backupPath = `${dbPath}.before-prune-${stamp(now)}-${i}`;
  const countBefore = countTasks(db);
  withBusyRetry(() => db.exec(`VACUUM INTO ${sqlString(backupPath)}`));
  const countAfter = countTasks(db);
  const backup = openReadOnly(backupPath);
  try {
    const check = backup.prepare('PRAGMA quick_check').get();
    const verdict = check && Object.values(check)[0];
    if (verdict !== 'ok') throw new Error(`backup failed its integrity check: ${verdict}`);
    const backupCount = countTasks(backup);
    const low = Math.min(countBefore, countAfter);
    const high = Math.max(countBefore, countAfter);
    if (backupCount < low || backupCount > high) {
      throw new Error(`backup has ${backupCount} tasks, the database had ${countBefore} to ${countAfter}`);
    }
    return { backupPath, backupCount, plan: planPrune(backup, { now, roots }) };
  } finally {
    backup.close();
  }
}

// Group work so each transaction deletes about maxRows rows. A task with more
// history than that still goes in one transaction of its own.
function chunkByRows(items, maxRows) {
  const chunks = [];
  let current = [];
  let rows = 0;
  for (const item of items) {
    const cost = item.events + item.uses + (item.kind === 'task' ? 1 : 0);
    if (current.length && rows + cost > maxRows) {
      chunks.push(current);
      current = [];
      rows = 0;
    }
    current.push(item);
    rows += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function applyPrune(dbPath, options = {}) {
  const {
    now = Date.now(),
    vacuum = false,
    graceMs = GRACE_MS,
    maxRowsPerBatch = MAX_ROWS_PER_BATCH,
    afterBackup = null,
    roots = tempRoots(),
  } = options;
  if (!fs.existsSync(dbPath)) return { db_path: dbPath, missing: true };
  const bytesBefore = dbBytes(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    if (!usesTaskIdIndex(db)) withBusyRetry(() => db.exec(TASK_ID_INDEX));
    if (!usesTaskIdIndex(db)) throw new Error('history lookups by task id have no index; nothing was removed');
    const { backupPath, backupCount, plan } = writeBackup(db, dbPath, now, roots);
    if (typeof afterBackup === 'function') afterBackup();

    const hasUses = tableExists(db, 'part_uses');
    const getTask = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`);
    const summary = db.prepare(EVENT_SQL.summary);
    const eventRoots = db.prepare(EVENT_SQL.roots);
    const delEvents = db.prepare(EVENT_SQL.remove);
    const delTask = db.prepare('DELETE FROM tasks WHERE id = ?');
    const delUses = hasUses ? db.prepare('DELETE FROM part_uses WHERE used_by = ?') : null;
    // part_uses has no index on used_by, so read a whole batch in one pass.
    const usesFor = hasUses
      ? db.prepare('SELECT used_by, COUNT(*) AS n FROM part_uses WHERE used_by IN (SELECT value FROM json_each(?)) GROUP BY used_by')
      : null;

    const removed = { tasks: 0, history_rows: 0, stray_history_rows: 0, part_uses: 0 };
    const skipped = { changed_since_backup: 0, held: 0, recent: 0, folder_exists: 0 };
    const chunks = chunkByRows(plan.rows, maxRowsPerBatch);
    let batches = 0;
    for (let c = 0; c < chunks.length; c++) {
      withBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
      try {
        // Fresh answers inside the lock: live clock, live disk, live rows.
        const cutoff = Date.now() - graceMs;
        const judge = makeJudge(roots);
        const liveUses = new Map();
        if (usesFor) {
          const ids = chunks[c].filter(item => item.kind === 'task').map(item => item.id);
          for (const row of usesFor.all(JSON.stringify(ids))) liveUses.set(row.used_by, Number(row.n));
        }
        for (const item of chunks[c]) {
          const live = getTask.get(item.id);
          if (item.kind === 'task' ? (!live || fingerprint(live) !== item.fp) : live) {
            skipped.changed_since_backup += 1;
            continue;
          }
          const ev = summary.get(item.id);
          if (Number(ev.n) !== item.events || (liveUses.get(item.id) || 0) !== item.uses) {
            skipped.changed_since_backup += 1;
            continue;
          }
          const lastAt = Math.max(Number(ev.last_at) || 0, live ? Number(live.updated_at) || 0 : 0);
          if (lastAt >= cutoff) { skipped.recent += 1; continue; }
          if (live && !isJunk(judge(live.workspace_root))) { skipped.folder_exists += 1; continue; }
          if (!eventRoots.all(item.id).every(r => isJunk(judge(r.workspace_root)))) { skipped.held += 1; continue; }

          const gone = Number(delEvents.run(item.id).changes);
          if (item.kind === 'stray') {
            removed.stray_history_rows += gone;
            continue;
          }
          delTask.run(item.id);
          removed.tasks += 1;
          removed.history_rows += gone;
          if (delUses && item.uses) removed.part_uses += Number(delUses.run(item.id).changes);
        }
        db.exec('COMMIT');
        batches += 1;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
      if (c + 1 < chunks.length) sleepSync(BATCH_PAUSE_MS);
    }

    let vacuumed = false;
    if (vacuum) {
      withBusyRetry(() => db.exec('VACUUM'));
      withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));
      vacuumed = true;
    }
    const { rows, ...planSummary } = plan;
    return {
      db_path: dbPath,
      backup_path: backupPath,
      backup_tasks: backupCount,
      bytes_before: bytesBefore,
      bytes_after: dbBytes(dbPath),
      total_tasks: countTasks(db),
      groups: planSummary.groups,
      planned: planSummary.remove,
      removed,
      skipped,
      kept: planSummary.kept,
      batches,
      vacuumed,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  GRACE_MS,
  EVENT_SQL,
  tempRoots,
  tempPrefixFor,
  folderGone,
  planPrune,
  dryRun,
  applyPrune,
};

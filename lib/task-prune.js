'use strict';

// Remove task rows that test runs wrote into the shared task database.
// A row is test junk only when its project folder sits under a temp
// directory (/tmp, /var/folders, os.tmpdir(), and their /private twins).
// A row with a real project path is never touched.
//
// planPrune reads only. applyPrune writes a consistent backup with
// VACUUM INTO, checks it, plans from the backup (so every removed row is in
// the backup), then deletes in short batches so live agents keep writing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { withBusyRetry } = require('./task-db');
const { sleepSync } = require('./sleep-sync');

// A temp task touched this recently may belong to a test still running.
const GRACE_MS = 60 * 60 * 1000;
const BATCH = 500;
const BATCH_PAUSE_MS = 20;
const BUSY_TIMEOUT_MS = 5000;

const NAMED_TEMP_ROOTS = [
  '/tmp', '/private/tmp',
  '/var/tmp', '/private/var/tmp',
  '/var/folders', '/private/var/folders',
];

function normalizeRoot(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw.startsWith('/') && !/^[A-Za-z]:\//.test(raw)) return null;
  const normal = path.posix.normalize(raw);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

function tempRoots() {
  const roots = new Set(NAMED_TEMP_ROOTS);
  const add = (dir) => {
    const key = normalizeRoot(dir);
    if (key && key !== '/') roots.add(key);
  };
  try {
    add(os.tmpdir());
    add(fs.realpathSync(os.tmpdir()));
  } catch {
    // os.tmpdir can throw in locked-down hosts; the named roots still apply.
  }
  // Shortest first so a row groups under the broad folder, e.g. /var/folders.
  return [...roots].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

// The temp root a project folder sits under, or null for a real project.
function tempPrefixFor(workspaceRoot, roots = tempRoots()) {
  const key = normalizeRoot(workspaceRoot);
  if (!key) return null;
  for (const root of roots) {
    if (key === root || key.startsWith(`${root}/`)) return root;
  }
  return null;
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
function planPrune(db, { now = Date.now(), graceMs = GRACE_MS } = {}) {
  const roots = tempRoots();
  const cutoff = now - graceMs;
  const prefixCache = new Map();
  const prefixOf = (root) => {
    if (!prefixCache.has(root)) prefixCache.set(root, tempPrefixFor(root, roots));
    return prefixCache.get(root);
  };

  const tasks = db.prepare('SELECT id, workspace_root, updated_at FROM tasks').all();
  const taskIds = new Set();
  for (const row of tasks) taskIds.add(row.id);

  // History rows per task, and whether any of them name a real project.
  const eventsByTask = new Map();
  const strays = [];
  for (const row of db.prepare(`
    SELECT task_id, workspace_root, COUNT(*) AS n, MAX(created_at) AS last_at
    FROM task_events GROUP BY task_id, workspace_root
  `).all()) {
    if (!taskIds.has(row.task_id)) {
      if (prefixOf(row.workspace_root) && Number(row.last_at) < cutoff) strays.push(row);
      continue;
    }
    const entry = eventsByTask.get(row.task_id) || { n: 0, real: false };
    entry.n += Number(row.n);
    if (!prefixOf(row.workspace_root)) entry.real = true;
    eventsByTask.set(row.task_id, entry);
  }

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
  const remove = [];
  const kept = { recent: 0, held: 0 };
  for (const row of tasks) {
    const prefix = prefixOf(row.workspace_root);
    if (!prefix) continue;
    const events = eventsByTask.get(row.id) || { n: 0, real: false };
    if (events.real) { kept.held += 1; continue; }
    if (!(Number(row.updated_at) < cutoff)) { kept.recent += 1; continue; }
    const g = group(prefix);
    g.tasks += 1;
    g.history_rows += events.n;
    g.part_uses += usesByTask.get(row.id) || 0;
    remove.push({ id: row.id, workspace_root: row.workspace_root, updated_at: row.updated_at });
  }
  const strayKeys = [];
  for (const row of strays) {
    group(prefixOf(row.workspace_root)).stray_history_rows += Number(row.n);
    strayKeys.push({ task_id: row.task_id, workspace_root: row.workspace_root });
  }

  const list = [...groups.values()].sort((a, b) => b.tasks - a.tasks || a.prefix.localeCompare(b.prefix));
  const sum = (field) => list.reduce((acc, g) => acc + g[field], 0);
  return {
    total_tasks: tasks.length,
    grace_hours: graceMs / (60 * 60 * 1000),
    groups: list,
    remove: {
      tasks: sum('tasks'),
      history_rows: sum('history_rows'),
      stray_history_rows: sum('stray_history_rows'),
      part_uses: sum('part_uses'),
    },
    kept,
    rows: remove,
    strays: strayKeys,
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

// Consistent copy while other processes write: VACUUM INTO reads one
// snapshot. A raw file copy of a live WAL database can tear.
function writeBackup(db, dbPath, now) {
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
    return { backupPath, backupCount, plan: planPrune(backup, { now }) };
  } finally {
    backup.close();
  }
}

function inBatches(db, items, fn) {
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    withBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    try {
      for (const item of slice) fn(item);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    if (i + BATCH < items.length) sleepSync(BATCH_PAUSE_MS);
  }
}

function applyPrune(dbPath, { now = Date.now(), vacuum = false } = {}) {
  if (!fs.existsSync(dbPath)) return { db_path: dbPath, missing: true };
  const bytesBefore = dbBytes(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    const { backupPath, backupCount, plan } = writeBackup(db, dbPath, now);
    const roots = tempRoots();
    const hasUses = tableExists(db, 'part_uses');
    const eventRoots = db.prepare('SELECT DISTINCT workspace_root FROM task_events WHERE task_id = ?');
    const delTask = db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_root = ? AND updated_at = ?');
    const delEvents = db.prepare('DELETE FROM task_events WHERE task_id = ?');
    const delUses = hasUses ? db.prepare('DELETE FROM part_uses WHERE used_by = ?') : null;
    const delStray = db.prepare(`DELETE FROM task_events WHERE task_id = ? AND workspace_root = ?
      AND created_at < ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_events.task_id)`);

    const removed = { tasks: 0, history_rows: 0, stray_history_rows: 0, part_uses: 0 };
    const skipped = { changed_since_backup: 0, held: 0 };
    inBatches(db, plan.rows, (row) => {
      // Re-check on the live rows: history naming a real project keeps the task.
      if (eventRoots.all(row.id).some(e => !tempPrefixFor(e.workspace_root, roots))) {
        skipped.held += 1;
        return;
      }
      // Same folder and same last touch as the backup, or it stays.
      if (delTask.run(row.id, row.workspace_root, row.updated_at).changes !== 1) {
        skipped.changed_since_backup += 1;
        return;
      }
      removed.tasks += 1;
      removed.history_rows += Number(delEvents.run(row.id).changes);
      if (delUses) removed.part_uses += Number(delUses.run(row.id).changes);
    });
    const strayCutoff = now - GRACE_MS;
    inBatches(db, plan.strays, (row) => {
      removed.stray_history_rows += Number(delStray.run(row.task_id, row.workspace_root, strayCutoff).changes);
    });

    let vacuumed = false;
    if (vacuum) {
      withBusyRetry(() => db.exec('VACUUM'));
      withBusyRetry(() => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'));
      vacuumed = true;
    }
    return {
      db_path: dbPath,
      backup_path: backupPath,
      backup_tasks: backupCount,
      bytes_before: bytesBefore,
      bytes_after: dbBytes(dbPath),
      total_tasks: countTasks(db),
      groups: plan.groups,
      planned: plan.remove,
      removed,
      skipped,
      kept: plan.kept,
      vacuumed,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  GRACE_MS,
  tempRoots,
  tempPrefixFor,
  planPrune,
  dryRun,
  applyPrune,
};

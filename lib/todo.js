// SHIM. Same export surface as the legacy markdown parser, but reads from the
// SQLite task store first when ATRIS_TASK_DB=1 is set, falling back to the
// pure markdown parser at lib/todo-fallback.js.
//
// All 3 callers (commands/autopilot.js, commands/status.js, commands/run.js)
// inherit the strangler without changing their import path.
//
// When ATRIS_TASK_DB=1:
//   parseTodo({path}) returns DB-derived tasks first; markdown rows whose
//   title doesn't already exist in DB are appended (so import is gradual).
// Otherwise: behaves exactly like the old parser.

'use strict';

const fallback = require('./todo-fallback');

const TASK_DB_ENABLED = process.env.ATRIS_TASK_DB === '1';

function dbToShimRow(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const verify = typeof metadata.verify === 'string' && metadata.verify.trim()
    ? metadata.verify.trim()
    : null;
  const claimed = row.claimed_by || metadata.claimed || null;
  // Map DB row → the shape the existing consumers expect from parseTodo().
  return {
    id: row.id,
    title: row.title,
    tag: row.tag || null,
    tags: row.tag ? [row.tag] : [],
    claimed,
    stage: row.status === 'claimed' ? 'in_progress' : (metadata.stage || null),
    verify,
    _source: 'db',
  };
}

function dbBuckets(workspaceRoot) {
  const taskDb = require('./task-db');
  const db = taskDb.open();
  const rows = taskDb.listTasks(db, { workspaceRoot, limit: 500 });
  // Need raw source_key for merge dedup, plus the shim shape for callers.
  const backlog = [];
  const inProgress = [];
  const completed = [];
  const sourceKeys = new Set();
  // Query directly so the shim can dedup against markdown by the strong key
  // even if future list filters hide rows.
  const stmt = db.prepare('SELECT id, source_key FROM tasks WHERE workspace_root = ? AND source_key IS NOT NULL');
  for (const r of stmt.all(workspaceRoot)) sourceKeys.add(r.source_key);
  for (const r of rows) {
    const shaped = dbToShimRow(r);
    if (r.status === 'open') backlog.push(shaped);
    else if (r.status === 'claimed') inProgress.push(shaped);
    else if (r.status === 'done' || r.status === 'failed') completed.push(shaped);
  }
  return { backlog, inProgress, completed, sourceKeys };
}

function mergeBuckets(dbBuck, mdBuck, todoPath) {
  // Append markdown rows that aren't already in the DB. Dedup by source_key
  // (strong: same source_file + normalized_title hash) first, and by
  // normalized_title as a compatibility fallback for legacy markdown rows
  // that pre-date the import path.
  const taskDb = require('./task-db');
  const norm = (t) => String(t || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const seenTitles = new Set();
  const out = { backlog: [], inProgress: [], completed: [] };
  for (const k of ['backlog', 'inProgress', 'completed']) {
    for (const r of dbBuck[k]) { out[k].push(r); seenTitles.add(norm(r.title)); }
    for (const r of mdBuck[k]) {
      const sk = todoPath ? taskDb.sourceKey(todoPath, r.title) : null;
      if (sk && dbBuck.sourceKeys && dbBuck.sourceKeys.has(sk)) continue;
      if (seenTitles.has(norm(r.title))) continue;
      out[k].push({ ...r, _source: 'md' });
    }
  }
  return out;
}

function parseTodo(todoPath) {
  // Legacy pure-markdown path.
  if (!TASK_DB_ENABLED) return fallback.parseTodoFile(todoPath);

  // DB-first merged view. Workspace scope = directory containing todoPath
  // (or its parent), so the DB stays per-repo.
  const path = require('path');
  const fs = require('fs');
  const taskDb = require('./task-db');
  let workspaceRoot;
  try {
    const todoAbs = path.resolve(todoPath);
    // typical layout: <repo>/atris/TODO.md → workspace = <repo>
    const guess = path.dirname(path.dirname(todoAbs));
    // Normalize via taskDb so it matches what `task add` writes.
    workspaceRoot = fs.existsSync(guess) ? taskDb.workspaceRoot(guess) : taskDb.workspaceRoot();
  } catch {
    workspaceRoot = taskDb.workspaceRoot();
  }

  let dbBuck;
  try {
    dbBuck = dbBuckets(workspaceRoot);
  } catch (e) {
    // If sqlite blew up (missing in node, perms), don't break the legacy path.
    if (process.env.ATRIS_DEBUG) console.error('[todo shim] db read failed:', e.message);
    return fallback.parseTodoFile(todoPath);
  }
  const mdBuck = fallback.parseTodoFile(todoPath);
  return mergeBuckets(dbBuck, mdBuck, todoPath);
}

module.exports = {
  parseTodo,
  parseSection: fallback.parseSection,
  getTeamMemberJournal: fallback.getTeamMemberJournal,
  listTeamMembers: fallback.listTeamMembers,
  getTeamActivity: fallback.getTeamActivity,
};

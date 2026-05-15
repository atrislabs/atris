// SQLite-backed task store. node:sqlite (built-in, v22+).
// Local state layer for `atris task`. TODO.md is a regenerated human-readable
// view; this store gives agents atomic claims plus an append-only event trail.
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
const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const TODO_RENDER_DONE_LIMIT = 8;
const PROJECTION_DONE_LIMIT = 8;
const PROJECTION_EVENT_LIMIT = 8;
const PROJECTION_MESSAGE_LIMIT = 6;
const PROJECTION_PAYLOAD_TEXT_LIMIT = 1000;
const AGENT_CERTIFICATION_REVIEW_PASSES = 2;
const TASK_REF_GENERIC_TOKENS = new Set(['app', 'atris', 'atrisos', 'project', 'repo', 'workspace']);

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
CREATE TABLE IF NOT EXISTS task_events (
  event_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  version         INTEGER NOT NULL,
  workspace_root  TEXT NOT NULL,
  actor           TEXT,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace   ON tasks(workspace_root);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by  ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_task_events_task  ON task_events(task_id, version);
CREATE INDEX IF NOT EXISTS idx_task_events_ws    ON task_events(workspace_root, created_at);
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
  // Schema version. Bump at every additive migration.
  // Future migrations read this and apply diffs idempotently.
  withBusyRetry(() => db.exec('PRAGMA user_version = 2'));
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

function normalizeTaskRef(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function workspaceRefPrefix(ws) {
  const base = path.basename(String(ws || 'task')).toLowerCase();
  const parts = base.split(/[^a-z0-9]+/).filter(Boolean);
  const useful = parts.filter(p => !TASK_REF_GENERIC_TOKENS.has(p));
  if (useful.length > 1) {
    const leading = useful.slice(0, -1).map(p => p[0]).join('').toUpperCase();
    const last = useful[useful.length - 1].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const lastKey = last[0] + last.slice(1).replace(/[AEIOU]/g, '');
    const combined = `${leading}${lastKey}`.replace(/[^A-Z0-9]/g, '');
    if (combined) return combined.slice(0, 3).padEnd(3, 'X');
  }
  const picked = useful.pop()
    || parts[parts.length - 1]
    || 'task';
  const token = picked.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return 'TSK';
  if (token.length <= 3) return token.padEnd(3, 'X');
  const consonantKey = token[0] + token.slice(1).replace(/[AEIOU]/g, '');
  return (consonantKey.length >= 3 ? consonantKey : token).slice(0, 3);
}

function taskDisplayRef(row, index) {
  return `${workspaceRefPrefix(row && row.workspace_root)}-${Number(index) + 1}`;
}

function shortestUniqueTaskRef(id, ids, minLength = 8) {
  const normalized = normalizeTaskRef(id);
  if (!normalized) return '';
  const all = (Array.isArray(ids) ? ids : []).map(normalizeTaskRef).filter(Boolean);
  for (let length = Math.min(minLength, normalized.length); length <= normalized.length; length += 1) {
    const prefix = normalized.slice(0, length);
    const matches = all.filter(candidate => candidate.startsWith(prefix));
    if (matches.length <= 1) return prefix;
  }
  return normalized;
}

function withTaskDisplayRefs(rows, refRows = rows) {
  const list = Array.isArray(rows) ? rows : [];
  const referenceInput = Array.isArray(refRows) ? refRows : list;
  const referenceIds = new Set(referenceInput.map(row => row && row.id).filter(Boolean));
  const referenceList = [
    ...referenceInput,
    ...list.filter(row => row && row.id && !referenceIds.has(row.id)),
  ];
  const byWorkspace = new Map();
  for (const row of referenceList) {
    const key = row && row.workspace_root || '';
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(row);
  }
  const refs = new Map();
  for (const group of byWorkspace.values()) {
    const sorted = [...group]
      .sort((a, b) => (Number(a.created_at || 0) - Number(b.created_at || 0)) || String(a.id || '').localeCompare(String(b.id || '')))
    const ids = sorted.map(row => row && row.id);
    sorted.forEach((row, index) => {
      refs.set(row.id, {
        display_id: taskDisplayRef(row, index),
        legacy_ref: shortestUniqueTaskRef(row.id, ids, 8),
      });
    });
  }
  return list.map(row => ({ ...row, ...(refs.get(row.id) || {}) }));
}

function taskDisplayRefMap(rows) {
  const map = new Map();
  for (const row of withTaskDisplayRefs(rows)) {
    map.set(row.id, row.display_id);
  }
  return map;
}

function addTask(db, { title, tag, workspaceRoot: ws, sourceKey: sk, metadata, status, claimedBy }) {
  if (!title || !String(title).trim()) throw new Error('title required');
  const now = Date.now();
  const id = newId();
  const taskStatus = ['open', 'claimed', 'review', 'done', 'failed'].includes(status) ? status : 'open';
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
  appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: ws,
    actor: claimedBy || null,
    eventType: taskStatus === 'claimed' ? 'claimed' : 'created',
    payload: {
      title: String(title).trim(),
      tag: tag || null,
      status: taskStatus,
      source_key: sk || null,
      metadata: metadata || null,
    },
  });
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
      CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 WHEN 'review' THEN 2 WHEN 'failed' THEN 3 WHEN 'done' THEN 4 ELSE 5 END,
      created_at DESC
    ${limit ? 'LIMIT ' + Number(limit) : ''}
  `;
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    metadata: r.metadata ? safeJSON(r.metadata) : null,
  }));
}

function getTask(db, id) {
  if (!id) throw new Error('id required');
  const row = db.prepare(`
    SELECT id, title, status, tag, workspace_root, source_key, claimed_by, claimed_at, created_at, updated_at, done_at, metadata
    FROM tasks
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  return { ...row, metadata: row.metadata ? safeJSON(row.metadata) : null };
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
    appendTaskEvent(db, {
      taskId: id,
      workspaceRoot: row.workspace_root,
      actor: claimedBy,
      eventType: 'claimed',
      payload: { claimed_by: claimedBy },
    });
    return { claimed: true, row: { ...row, metadata: row.metadata ? safeJSON(row.metadata) : null } };
  }
  // Either id doesn't exist or status != 'open'. Tell the caller which.
  const row = db.prepare('SELECT id, status, claimed_by FROM tasks WHERE id = ?').get(id);
  if (!row) return { claimed: false, reason: 'not_found' };
  return { claimed: false, reason: 'already_' + row.status, claimed_by: row.claimed_by };
}

function doneTask(db, { id, status, actor }) {
  if (!id) throw new Error('id required');
  const final = status || 'done';
  if (!['done', 'failed'].includes(final)) throw new Error('status must be done|failed');
  const now = Date.now();
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = ?, done_at = ?, updated_at = ?
     WHERE id = ?
       AND status IN ('open', 'claimed', 'review')
  `).run(final, now, now, id));
  if (result.changes === 1) {
    const row = db.prepare('SELECT id, workspace_root FROM tasks WHERE id = ?').get(id);
    appendTaskEvent(db, {
      taskId: id,
      workspaceRoot: row.workspace_root,
      actor: actor || process.env.ATRIS_AGENT_ID || process.env.USER || null,
      eventType: final === 'done' ? 'completed' : 'blocked',
      payload: { status: final },
    });
  }
  return { updated: result.changes === 1 };
}

function readyTask(db, { id, actor, proof, lesson, nextTask }) {
  if (!id) throw new Error('id required');
  const text = String(proof || '').trim();
  if (!text) throw new Error('proof required');
  const row = getTask(db, id);
  if (!row) return { ready: false, reason: 'not_found' };
  if (!['open', 'claimed', 'review'].includes(row.status)) {
    return { ready: false, reason: `already_${row.status}` };
  }
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const reviewPassCount = Number(metadata.agent_review_pass_count || 0) + 1;
  metadata.approval_status = 'pending';
  metadata.agent_review_pass_count = reviewPassCount;
  metadata.agent_reviewed_at = new Date(now).toISOString();
  metadata.agent_reviewed_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  metadata.latest_agent_proof = text;
  if (reviewPassCount >= AGENT_CERTIFICATION_REVIEW_PASSES) {
    metadata.agent_certified = true;
    metadata.agent_certified_at = new Date(now).toISOString();
    metadata.agent_certified_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
    metadata.agent_certification_policy = `${AGENT_CERTIFICATION_REVIEW_PASSES}_agent_review_passes`;
  }
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'review',
           done_at = NULL,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
       AND status IN ('open', 'claimed', 'review')
  `).run(now, JSON.stringify(metadata), id));
  if (result.changes !== 1) return { ready: false, reason: 'not_open_claimed_or_review' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actor || null,
    eventType: 'proof_ready',
    payload: {
      proof: text,
      lesson: String(lesson || '').trim() || null,
      next_task: String(nextTask || '').trim() || null,
      approval_status: 'pending',
      review_pass_count: reviewPassCount,
      agent_certified: metadata.agent_certified === true,
      agent_certification_policy: metadata.agent_certification_policy || null,
    },
  });
  return { ready: true, event, row: updated };
}

function reviseTask(db, { id, actor, note }) {
  if (!id) throw new Error('id required');
  const text = String(note || '').trim();
  if (!text) throw new Error('note required');
  const row = getTask(db, id);
  if (!row) return { revised: false, reason: 'not_found' };
  if (!['review', 'done', 'failed'].includes(row.status)) {
    return { revised: false, reason: `not_reviewable_${row.status}` };
  }
  const now = Date.now();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  const revisionCount = Number(metadata.human_revision_count || 0) + 1;
  metadata.approval_status = 'revise';
  metadata.human_revision_count = revisionCount;
  metadata.human_revision_at = new Date(now).toISOString();
  metadata.human_revision_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
  metadata.human_revision_note = text;
  const result = withBusyRetry(() => db.prepare(`
    UPDATE tasks
       SET status = 'claimed',
           done_at = NULL,
           updated_at = ?,
           metadata = ?
     WHERE id = ?
  `).run(now, JSON.stringify(metadata), id));
  if (result.changes !== 1) return { revised: false, reason: 'not_updated' };
  const updated = getTask(db, id);
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: updated.workspace_root,
    actor: actor || null,
    eventType: 'revision_requested',
    payload: {
      note: text,
      approval_status: 'revise',
      revision_count: revisionCount,
    },
  });
  return { revised: true, event, row: updated };
}

function appendTaskEvent(db, { taskId, workspaceRoot: ws, actor, eventType, payload }) {
  if (!taskId) throw new Error('taskId required');
  if (!ws) throw new Error('workspaceRoot required');
  if (!eventType) throw new Error('eventType required');
  const current = db.prepare('SELECT MAX(version) AS version FROM task_events WHERE task_id = ?').get(taskId);
  const version = Number(current && current.version || 0) + 1;
  const eventId = newId();
  const now = Date.now();
  withBusyRetry(() => db.prepare(`
    INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    taskId,
    version,
    ws,
    actor || null,
    eventType,
    payload ? JSON.stringify(payload) : null,
    now,
  ));
  return {
    event_id: eventId,
    task_id: taskId,
    version,
    workspace_root: ws,
    actor: actor || null,
    event_type: eventType,
    payload: payload || null,
    created_at: now,
  };
}

function listTaskEvents(db, { taskId, workspaceRoot: ws, limit, order = 'asc' }) {
  const where = [];
  const args = [];
  if (taskId) { where.push('task_id = ?'); args.push(taskId); }
  if (ws) { where.push('workspace_root = ?'); args.push(ws); }
  const sort = String(order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sql = `
    SELECT event_id, task_id, version, workspace_root, actor, event_type, payload, created_at
    FROM task_events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at ${sort}, version ${sort}
    ${limit ? 'LIMIT ' + Number(limit) : ''}
  `;
  return db.prepare(sql).all(...args).map(r => ({
    ...r,
    payload: r.payload ? safeJSON(r.payload) : null,
  }));
}

function noteTask(db, { id, actor, content }) {
  if (!id) throw new Error('id required');
  const text = String(content || '').trim();
  if (!text) throw new Error('content required');
  const row = getTask(db, id);
  if (!row) return { noted: false, reason: 'not_found' };
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: row.workspace_root,
    actor: actor || null,
    eventType: 'message',
    payload: { content: text },
  });
  return { noted: true, event };
}

function reviewTask(db, { id, actor, reward, lesson, nextTask, proof }) {
  if (!id) throw new Error('id required');
  const row = getTask(db, id);
  if (!row) return { reviewed: false, reason: 'not_found' };
  const numericReward = Number.isFinite(Number(reward)) ? Number(reward) : 0;
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
  if (numericReward > 0) {
    metadata.approval_status = 'accepted';
    metadata.accepted_at = new Date().toISOString();
    metadata.accepted_by = actor || process.env.ATRIS_AGENT_ID || process.env.USER || null;
    withBusyRetry(() => db.prepare(`
      UPDATE tasks
         SET metadata = ?,
             updated_at = ?
       WHERE id = ?
    `).run(JSON.stringify(metadata), Date.now(), id));
  }
  const payload = {
    reward: numericReward,
    lesson: String(lesson || '').trim(),
    next_task: String(nextTask || '').trim() || null,
    proof: String(proof || '').trim() || null,
  };
  const event = appendTaskEvent(db, {
    taskId: id,
    workspaceRoot: row.workspace_root,
    actor: actor || null,
    eventType: 'reviewed',
    payload,
  });
  const episode = taskEpisodeFromReview({ ...row, metadata }, event, payload);
  appendTaskEpisode(row.workspace_root, episode);
  return { reviewed: true, event, episode };
}

function compactEpisodeText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function goalSignalFromTaskMetadata(metadata) {
  const goalId = compactEpisodeText(metadata.goal_id || metadata.goalId || metadata.goal?.id || '', 120);
  const objective = compactEpisodeText(
    metadata.goal_objective || metadata.goalObjective || metadata.goal?.objective || metadata.goal || '',
    240,
  );
  if (!goalId && !objective) return null;
  return {
    goal_id: goalId,
    objective,
  };
}

function reviewOutcomeLabel(reward) {
  const value = Number(reward);
  if (!Number.isFinite(value)) return 'reviewed';
  if (value > 0) return 'accepted';
  if (value < 0) return 'rejected';
  return 'revised';
}

function taskEpisodeFromReview(row, event, payload) {
  const metadata = row.metadata || {};
  const rewardValue = Number(payload.reward);
  const hasProof = Boolean(String(payload.proof || '').trim());
  const label = reviewOutcomeLabel(payload.reward);
  return {
    schema: 'atris.task_episode.v1',
    episode_id: event.event_id,
    task_id: row.id,
    workspace_root: row.workspace_root,
    created_at: new Date(event.created_at).toISOString(),
    state: {
      title: row.title,
      status: row.status,
      tag: row.tag,
      claimed_by: row.claimed_by,
      metadata,
    },
    action: {
      event_type: 'reviewed',
      actor: event.actor || null,
      version: event.version,
    },
    reward: {
      value: payload.reward,
      source: 'task_review',
    },
    lesson: payload.lesson,
    proof: payload.proof,
    next_task_suggestion: payload.next_task,
    goal: goalSignalFromTaskMetadata(metadata),
    career_xp: {
      eligible: label === 'accepted' && hasProof,
      source: 'task_review',
      reward: Number.isFinite(rewardValue) ? rewardValue : 0,
      proof_required: true,
    },
    rl: {
      label,
      source: 'task_review',
      reward: Number.isFinite(rewardValue) ? rewardValue : 0,
      has_proof: hasProof,
      has_lesson: Boolean(String(payload.lesson || '').trim()),
      has_next_task: Boolean(String(payload.next_task || '').trim()),
    },
  };
}

function appendTaskEpisode(workspaceRoot, episode) {
  const filePath = path.join(workspaceRoot, TASK_EPISODES_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(episode) + '\n', 'utf8');
  return filePath;
}

function clipProjectionText(value, max = PROJECTION_PAYLOAD_TEXT_LIMIT) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactProjectionPayload(value) {
  if (typeof value === 'string') return clipProjectionText(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(compactProjectionPayload);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = clipProjectionText(item);
    else if (item && typeof item === 'object') out[key] = compactProjectionPayload(item);
    else out[key] = item;
  }
  return out;
}

function compactProjectionEvent(event) {
  return {
    ...event,
    payload: compactProjectionPayload(event.payload),
  };
}

function selectProjectionRows(rows, { taskId, includeHistory, doneLimit }) {
  if (taskId || includeHistory) {
    return {
      visibleRows: rows,
      hiddenDoneCount: 0,
    };
  }
  const visibleRows = [];
  let shownDone = 0;
  let hiddenDoneCount = 0;
  for (const row of rows) {
    if (row.status === 'done') {
      if (shownDone < doneLimit) {
        visibleRows.push(row);
        shownDone += 1;
      } else {
        hiddenDoneCount += 1;
      }
      continue;
    }
    visibleRows.push(row);
  }
  return { visibleRows, hiddenDoneCount };
}

function taskProjection(db, {
  workspaceRoot: ws,
  taskId,
  limit = 500,
  includeHistory = Boolean(taskId),
  doneLimit = PROJECTION_DONE_LIMIT,
  eventLimit = PROJECTION_EVENT_LIMIT,
  messageLimit = PROJECTION_MESSAGE_LIMIT,
} = {}) {
  const rows = taskId
    ? [getTask(db, taskId)].filter(Boolean)
    : listTasks(db, { workspaceRoot: ws || null, limit });
  const refRows = taskId && rows[0]
    ? listTasks(db, { workspaceRoot: rows[0].workspace_root })
    : listTasks(db, { workspaceRoot: ws || null });
  const refById = new Map(withTaskDisplayRefs(refRows).map(row => [row.id, {
    display_id: row.display_id,
    legacy_ref: row.legacy_ref,
  }]));
  const { visibleRows, hiddenDoneCount } = selectProjectionRows(rows, {
    taskId,
    includeHistory,
    doneLimit: Math.max(0, Number(doneLimit) || 0),
  });
  const events = listTaskEvents(db, {
    taskId: taskId || null,
    workspaceRoot: taskId ? null : (ws || null),
    limit: limit * 20,
  });
  const byTask = new Map();
  for (const e of events) {
    if (!byTask.has(e.task_id)) byTask.set(e.task_id, []);
    byTask.get(e.task_id).push(e);
  }
  return {
    schema: 'atris.task_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: ws || (rows[0] && rows[0].workspace_root) || null,
    surface: {
      compact: !includeHistory,
      full_task_count: rows.length,
      visible_task_count: visibleRows.length,
      hidden_done_count: hiddenDoneCount,
      done_limit: includeHistory ? null : Math.max(0, Number(doneLimit) || 0),
      event_limit: includeHistory ? null : Math.max(0, Number(eventLimit) || 0),
      message_limit: includeHistory ? null : Math.max(0, Number(messageLimit) || 0),
      full_ledger_command: taskId ? `atris task events ${taskId}` : 'atris task events --all',
    },
    tasks: visibleRows.map(row => {
      const taskEvents = byTask.get(row.id) || [];
      const latest = taskEvents.length ? taskEvents[taskEvents.length - 1] : null;
      const allMessages = taskEvents
        .filter(e => e.event_type === 'message')
        .map(e => ({
          version: e.version,
          actor: e.actor,
          content: clipProjectionText(e.payload && e.payload.content || ''),
          created_at: e.created_at,
        }));
      const visibleMessages = includeHistory ? allMessages : allMessages.slice(-Math.max(0, Number(messageLimit) || 0));
      const visibleEvents = includeHistory ? taskEvents : taskEvents.slice(-Math.max(0, Number(eventLimit) || 0)).map(compactProjectionEvent);
      return {
        id: row.id,
        ...(refById.get(row.id) || {}),
        title: row.title,
        status: row.status,
        tag: row.tag,
        workspace_root: row.workspace_root,
        claimed_by: row.claimed_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        done_at: row.done_at,
        metadata: row.metadata || {},
        current_version: latest ? latest.version : 0,
        latest_event_type: latest ? latest.event_type : null,
        messages: visibleMessages,
        events: visibleEvents,
        history: {
          event_count: taskEvents.length,
          message_count: allMessages.length,
          events_visible: visibleEvents.length,
          messages_visible: visibleMessages.length,
          events_truncated: !includeHistory && taskEvents.length > visibleEvents.length,
          messages_truncated: !includeHistory && allMessages.length > visibleMessages.length,
        },
      };
    }),
  };
}

function renderTodoMarkdown(rows, { title = 'TODO.md', doneLimit = TODO_RENDER_DONE_LIMIT, refRows = rows } = {}) {
  const displayRows = withTaskDisplayRefs(rows, refRows);
  const buckets = {
    open: displayRows.filter(r => r.status === 'open'),
    claimed: displayRows.filter(r => r.status === 'claimed'),
    review: displayRows.filter(r => r.status === 'review'),
    failed: displayRows.filter(r => r.status === 'failed'),
    done: displayRows.filter(r => r.status === 'done'),
  };
  const lines = [`# ${title}`, '', '> Regenerated from durable Atris task state. Do not treat this file as truth.', ''];
  appendSection(lines, 'Backlog', buckets.open);
  appendSection(lines, 'In Progress', buckets.claimed);
  appendSection(lines, 'Review', buckets.review);
  appendSection(lines, 'Blocked', buckets.failed);
  const renderedDone = buckets.done.slice(0, Math.max(0, Number(doneLimit) || 0));
  appendSection(lines, 'Completed', renderedDone);
  const archivedDone = Math.max(0, buckets.done.length - renderedDone.length);
  if (archivedDone > 0) {
    lines.push(`(${archivedDone} older completed task${archivedDone === 1 ? '' : 's'} archived in \`atris task list --status done\` and \`atris task events\`.)`, '');
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function appendSection(lines, name, rows) {
  lines.push(`## ${name}`, '');
  if (!rows.length) {
    lines.push('(Empty)', '');
    return;
  }
  for (const row of rows) {
    const tag = row.tag ? ` [${row.tag}]` : '';
    lines.push(`- **[${row.display_id || row.id}]** ${row.title}${tag}`);
    if (row.claimed_by && row.status === 'claimed') lines.push(`  **Claimed by:** ${row.claimed_by}`);
    const meta = row.metadata || {};
    if (meta.verify) lines.push(`  **Verify:** ${meta.verify}`);
  }
  lines.push('');
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
  getTask,
  listTasks,
  claimTask,
  doneTask,
  readyTask,
  reviseTask,
  noteTask,
  reviewTask,
  appendTaskEvent,
  listTaskEvents,
  taskProjection,
  renderTodoMarkdown,
  normalizeTaskRef,
  shortestUniqueTaskRef,
  taskDisplayRefMap,
  withTaskDisplayRefs,
  newId,
  // Test surface
  _SCHEMA: SCHEMA,
};

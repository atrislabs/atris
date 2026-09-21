'use strict';

// Puts finished and untouched tasks off the visible list. History stays
// archived. A current list costs one indexed lookup and no writes.

const fs = require('fs');
const path = require('path');
const taskDb = require('./task-db');

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = new Set(['open', 'claimed', 'review']);

// Failed rows already leave the today screen after 7 days. They stay
// findable until 30 days, then they leave the list too.
const IDLE_LIMITS_MS = {
  claimed: 3 * DAY_MS,
  open: 14 * DAY_MS,
  review: 14 * DAY_MS,
  failed: 30 * DAY_MS,
};

const REASONS = {
  done: 'finished work left the list',
  claimed: 'claimed work sat untouched for 3 days',
  open: 'waiting work sat untouched for 14 days',
  review: 'review sat untouched for 14 days',
  failed: 'failed work sat untouched for 30 days',
};

const CANDIDATE_SQL = `
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND status = 'done'
  UNION ALL
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND status = 'claimed' AND updated_at < ?
  UNION ALL
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND status = 'open' AND updated_at < ?
  UNION ALL
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND status = 'review' AND updated_at < ?
  UNION ALL
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND status = 'failed' AND updated_at < ?
  UNION ALL
  SELECT id, title, status, tag, updated_at, created_at, done_at, metadata
    FROM tasks
   WHERE workspace_root = ? AND tag = 'mission-blocker' AND status IN ('open', 'claimed', 'review')
`;

function actorName(actor) {
  return actor || process.env.ATRIS_AGENT_ID || process.env.USER || 'task-list';
}

function decisionFor(row, now) {
  if (!row || row.status === 'archived') return null;
  if (row.status === 'done') {
    return { reason: REASONS.done, fromDone: true, fromFailed: false };
  }
  if (!Object.prototype.hasOwnProperty.call(IDLE_LIMITS_MS, row.status)) return null;
  const at = Number(row.updated_at || row.created_at || 0);
  if (!((now - at) > IDLE_LIMITS_MS[row.status])) return null;
  return { reason: REASONS[row.status], fromDone: false, fromFailed: row.status === 'failed' };
}

function selectCandidates(db, workspaceRoot, now) {
  return db.prepare(CANDIDATE_SQL).all(
    workspaceRoot,
    workspaceRoot, now - IDLE_LIMITS_MS.claimed,
    workspaceRoot, now - IDLE_LIMITS_MS.open,
    workspaceRoot, now - IDLE_LIMITS_MS.review,
    workspaceRoot, now - IDLE_LIMITS_MS.failed,
    workspaceRoot,
  );
}

function blockerFrom(row) {
  if (!row || row.tag !== 'mission-blocker' || !OPEN_STATUSES.has(row.status)) return null;
  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  if (!metadata || !metadata.mission_id || !metadata.mission_blocker_class) return null;
  return { ...row, metadata };
}

function loadMissions(workspaceRoot) {
  try {
    return require('../commands/mission').listMissions(workspaceRoot) || [];
  } catch {
    return [];
  }
}

function noteKeep(workspaceRoot, actor, count) {
  if (!count || !workspaceRoot || !fs.existsSync(path.join(workspaceRoot, 'atris'))) return;
  try {
    const now = new Date();
    const year = String(now.getFullYear());
    const dir = path.join(workspaceRoot, 'atris', 'logs', year);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;
    const stamp = now.toTimeString().slice(0, 5);
    fs.appendFileSync(path.join(dir, name), `## ${stamp} · Task list kept\n- count: ${count}\n- actor: ${actor}\n\n`);
  } catch {
    // The rows are already off the list. A missed note should not put them back.
  }
}

function keepTaskList(db, { workspaceRoot, actor, now = Date.now(), missions } = {}) {
  const who = actorName(actor);
  const seen = new Set();
  const toArchive = [];
  const blockers = [];
  for (const row of selectCandidates(db, workspaceRoot, now)) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const decision = decisionFor(row, now);
    if (decision) {
      toArchive.push({ id: row.id, previous_status: row.status, ...decision });
      continue;
    }
    const blocker = blockerFrom(row);
    if (blocker) blockers.push(blocker);
  }

  const missionList = Array.isArray(missions)
    ? missions
    : (blockers.length ? loadMissions(workspaceRoot) : []);
  if (!toArchive.length && !(blockers.length && missionList.length)) {
    return { put_away: [], reaped: [] };
  }

  const putAway = [];
  let reaped = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of toArchive) {
      const result = taskDb.archiveTask(db, {
        id: item.id,
        actor: who,
        reason: item.reason,
        fromDone: item.fromDone,
        fromFailed: item.fromFailed,
        skipLogs: true,
      });
      if (result.archived) {
        putAway.push({ id: item.id, previous_status: item.previous_status, reason: item.reason });
      }
    }
    if (blockers.length && missionList.length) {
      reaped = taskDb.reapMissionBlockerTasks(db, {
        workspaceRoot,
        missions: missionList,
        actor: who,
        rows: blockers,
        skipLogs: true,
      }).closed || [];
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is the one to surface */ }
    throw error;
  }
  noteKeep(workspaceRoot, who, putAway.length + reaped.length);
  return { put_away: putAway, reaped };
}

function keepWorkspaceTaskList(cwd = process.cwd(), { actor } = {}) {
  const dbPath = taskDb.getDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { put_away: [], reaped: [], skipped: 'no_db' };
  }
  const db = taskDb.open();
  return keepTaskList(db, {
    workspaceRoot: taskDb.workspaceRoot(cwd),
    actor,
    now: Date.now(),
  });
}

module.exports = {
  DAY_MS,
  IDLE_LIMITS_MS,
  REASONS,
  keepTaskList,
  keepWorkspaceTaskList,
};

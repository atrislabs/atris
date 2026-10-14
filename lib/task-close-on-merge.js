'use strict';

// A job waiting in review whose change already merged on GitHub is finished:
// close it. A job whose change was closed without merging goes back to open
// with the reason, so somebody picks it up again instead of it sitting forever.
//
// Jobs rarely record their branch, but every member run cuts one named
// codex/<member>-<title slug>-<stamp>, so the title and the member find it.
// Only changes opened after the job was created count, so a new job that
// reuses an old title never closes on someone else's old merge.
//
// Rules from two refused tries: jobs held for a human (needs-human or
// decision) are never touched; a merge counts only when it went into master
// and its merge commit is on master; one change settles only the one job
// that owns its branch; GitHub is asked at most every ten minutes unless the
// landing tick forces it; old-job cleanup waits until this check has seen a
// waiting job.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const taskDb = require('./task-db');
const { isDecisionTask } = require('./task-decision');

const BASE_BRANCH = 'master';
const CHECK_EVERY_MS = 10 * 60 * 1000;
const STATE_FILE = path.join('.atris', 'state', 'task_close_on_merge.json');

const STAMP = /^\d{8}-\d{6}(?:-\d+)?$/;

function slugify(value, fallback, limit) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function metadataOf(row) {
  let metadata = row && row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  return metadata && typeof metadata === 'object' ? metadata : {};
}

function explicitBranch(metadata) {
  return String(
    metadata.branch
      || metadata.worktree_branch
      || metadata.git_branch
      || metadata.pr_branch
      || metadata.head_branch
      || (metadata.worktree && metadata.worktree.branch)
      || ''
  ).trim() || null;
}

function branchMatches(row, headRefName) {
  const head = String(headRefName || '');
  const metadata = metadataOf(row);
  const explicit = explicitBranch(metadata);
  if (explicit) return head === explicit;
  const titleSlug = slugify(row.title, 'task', 36);
  const members = [row.claimed_by, metadata.built_by]
    .filter(Boolean)
    .map(member => slugify(member, 'member', 24));
  return members.some((member) => {
    const prefix = `codex/${member}-${titleSlug}-`;
    return head.startsWith(prefix) && STAMP.test(head.slice(prefix.length));
  });
}

function changesFor(row, pulls) {
  const createdAt = Number(row.created_at || 0);
  return pulls
    .filter(pull => String(pull.baseRefName || '') === BASE_BRANCH)
    .filter(pull => branchMatches(row, pull.headRefName))
    .filter(pull => !pull.createdAt || Date.parse(pull.createdAt) >= createdAt)
    .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
}

function isMerged(pull) {
  return Boolean(pull.mergedAt) || String(pull.state).toUpperCase() === 'MERGED';
}

function mergeCommitOf(pull) {
  const commit = pull && pull.mergeCommit;
  return String((commit && (commit.oid || commit.sha)) || '').trim() || null;
}

// What GitHub says about the job's change: merged, rejected, or nothing yet.
// A merge only counts when its merge commit is really on master.
function verdictFor(row, pulls, { onMaster = () => true } = {}) {
  const changes = changesFor(row, pulls);
  if (!changes.length) return null;
  const merged = changes.find(isMerged);
  if (merged) {
    const commit = mergeCommitOf(merged);
    return commit && onMaster(commit) ? { verdict: 'merged', pull: merged } : null;
  }
  const newest = changes[0];
  if (String(newest.state).toUpperCase() === 'CLOSED') return { verdict: 'rejected', pull: newest };
  return null;
}

// A job that names its branch owns that change outright. Otherwise a change
// that several jobs could own by title belongs to none of them.
function ownedVerdicts(rows, pulls, options) {
  const found = [];
  for (const row of rows) {
    const verdict = verdictFor(row, pulls, options);
    if (verdict) found.push({ row, ...verdict, explicit: Boolean(explicitBranch(metadataOf(row))) });
  }
  const byChange = new Map();
  for (const item of found) {
    const key = item.pull.number || item.pull.url || item.pull.headRefName;
    if (!byChange.has(key)) byChange.set(key, []);
    byChange.get(key).push(item);
  }
  const owned = [];
  for (const claims of byChange.values()) {
    const named = claims.filter(item => item.explicit);
    const pick = named.length ? named : claims;
    if (pick.length === 1) owned.push(pick[0]);
  }
  return owned;
}

function gitOnMaster(root) {
  let fetched = false;
  return (commit) => {
    if (!fetched) {
      fetched = true;
      spawnSync('git', ['fetch', '--quiet', 'origin', BASE_BRANCH], { cwd: root, timeout: 30000 });
    }
    const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, `origin/${BASE_BRANCH}`], {
      cwd: root,
      timeout: 10000,
    });
    return result.status === 0;
  };
}

function githubPulls(root) {
  const result = spawnSync('gh', [
    'pr', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,state,baseRefName,headRefName,mergedAt,mergeCommit,createdAt,url',
  ], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function closeMergedTasks(db, { workspaceRoot, actor, lookupPulls = githubPulls, onMaster } = {}) {
  const who = actor || process.env.ATRIS_AGENT_ID || process.env.USER || 'task-list';
  const rows = db.prepare(
    "SELECT id, title, status, tag, claimed_by, created_at, metadata FROM tasks WHERE workspace_root = ? AND status = 'review'"
  ).all(workspaceRoot)
    .filter(row => !isDecisionTask({ ...row, metadata: metadataOf(row) }));
  const closed = [];
  const reopened = [];
  if (!rows.length) return { closed, reopened };
  const pulls = lookupPulls(workspaceRoot);
  if (!Array.isArray(pulls)) return { closed, reopened, skipped: 'github_unavailable' };
  const owned = ownedVerdicts(rows, pulls, { onMaster: onMaster || gitOnMaster(workspaceRoot) });
  for (const { row, verdict, pull } of owned) {
    const change = pull.url || `#${pull.number}`;
    if (verdict === 'merged') {
      const result = taskDb.doneTask(db, {
        id: row.id,
        status: 'done',
        actor: who,
        allowReview: true,
        action: 'merged',
        proof: `its change merged on GitHub: ${change}`,
      });
      if (result.updated) closed.push({ id: row.id, title: row.title, change });
    } else {
      const reason = `its change was closed on GitHub without merging: ${change}`;
      const result = taskDb.reopenTask(db, { id: row.id, actor: who, reason, fromReview: true });
      if (result.reopened) reopened.push({ id: row.id, title: row.title, change, reason });
    }
  }
  return { closed, reopened };
}

function statePath(workspaceRoot) {
  return path.join(workspaceRoot, STATE_FILE);
}

// When GitHub last answered for this workspace, or null if it never has.
function lastCheckedAt(workspaceRoot) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(workspaceRoot), 'utf8'));
    const at = Number(state && state.checked_at);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

function noteChecked(workspaceRoot, at) {
  try {
    fs.mkdirSync(path.dirname(statePath(workspaceRoot)), { recursive: true });
    fs.writeFileSync(statePath(workspaceRoot), `${JSON.stringify({ checked_at: at })}\n`);
  } catch {
    // Without the note the next tidy asks again sooner; nothing breaks.
  }
}

// Ask GitHub only when ten minutes have passed since it last answered, or
// always when force is set (the landing tick). The time is taken before the
// question, so a job that turns up mid-question is not counted as seen.
function closeMergedTasksIfDue(db, { workspaceRoot, actor, force = false, now = Date.now(), lookupPulls, onMaster } = {}) {
  const last = lastCheckedAt(workspaceRoot);
  if (!force && last && now - last < CHECK_EVERY_MS) {
    return { closed: [], reopened: [], skipped: 'not_due', checked_at: last };
  }
  const result = closeMergedTasks(db, { workspaceRoot, actor, lookupPulls, onMaster });
  if (result.skipped) return { ...result, checked_at: last };
  noteChecked(workspaceRoot, now);
  return { ...result, checked_at: now };
}

module.exports = {
  CHECK_EVERY_MS,
  closeMergedTasks,
  closeMergedTasksIfDue,
  lastCheckedAt,
  verdictFor,
};

'use strict';

// A job waiting in review whose change already merged on GitHub is finished:
// close it. A job whose change was closed without merging goes back to open
// with the reason, so somebody picks it up again instead of it sitting forever.
//
// Jobs rarely record their branch, but every member run cuts one named
// codex/<member>-<title slug>-<stamp>, so the title and the member find it.
// Only changes opened after the job was created count, so a new job that
// reuses an old title never closes on someone else's old merge.

const { spawnSync } = require('child_process');
const taskDb = require('./task-db');

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
    .filter(pull => branchMatches(row, pull.headRefName))
    .filter(pull => !pull.createdAt || Date.parse(pull.createdAt) >= createdAt)
    .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));
}

// What GitHub says about the job's change: merged, rejected, or nothing yet.
function verdictFor(row, pulls) {
  const changes = changesFor(row, pulls);
  if (!changes.length) return null;
  const merged = changes.find(pull => pull.mergedAt || String(pull.state).toUpperCase() === 'MERGED');
  if (merged) return { verdict: 'merged', pull: merged };
  const newest = changes[0];
  if (String(newest.state).toUpperCase() === 'CLOSED') return { verdict: 'rejected', pull: newest };
  return null;
}

function githubPulls(root) {
  const result = spawnSync('gh', [
    'pr', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,state,headRefName,mergedAt,createdAt,url',
  ], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function closeMergedTasks(db, { workspaceRoot, actor, lookupPulls = githubPulls } = {}) {
  const who = actor || process.env.ATRIS_AGENT_ID || process.env.USER || 'task-list';
  const rows = db.prepare(
    "SELECT id, title, status, claimed_by, created_at, metadata FROM tasks WHERE workspace_root = ? AND status = 'review'"
  ).all(workspaceRoot);
  const closed = [];
  const reopened = [];
  if (!rows.length) return { closed, reopened };
  const pulls = lookupPulls(workspaceRoot);
  if (!Array.isArray(pulls)) return { closed, reopened, skipped: 'github_unavailable' };
  for (const row of rows) {
    const found = verdictFor(row, pulls);
    if (!found) continue;
    const { verdict, pull } = found;
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

module.exports = {
  branchMatches,
  closeMergedTasks,
  githubPulls,
  verdictFor,
};

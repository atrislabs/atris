'use strict';

// A task waiting in review whose branch already merged is finished. Close it
// so nobody has to accept work that is already on master.
//
// Guards against closing too early:
// - only review rows, and never a protected lane (those wait for a human);
// - the branch must exist and be an ancestor of the base;
// - the branch tip must be newer than the task, so a fresh branch cut from
//   master with no commits of its own does not read as merged.
// Squash merges leave no ancestor link and are not caught here.

const { spawnSync } = require('child_process');
const taskDb = require('./task-db');
const { protectedLaneOf } = require('./auto-accept-certified');

const BASE_CANDIDATES = ['origin/master', 'origin/main', 'master', 'main'];

function parsedMetadata(row) {
  let metadata = row && row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  return metadata && typeof metadata === 'object' ? metadata : {};
}

function cleanRef(value) {
  const ref = String(value || '').trim();
  if (!ref || ref.startsWith('-') || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) return null;
  return ref;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  return { ok: result.status === 0, out: String(result.stdout || '').trim() };
}

function resolveRef(root, ref) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok && result.out ? result.out : null;
}

function branchOf(metadata) {
  return cleanRef(
    metadata.branch
      || metadata.worktree_branch
      || metadata.git_branch
      || metadata.pr_branch
      || metadata.head_branch
      || (metadata.worktree && metadata.worktree.branch)
  );
}

function baseOf(root, metadata) {
  const named = cleanRef(
    metadata.base
      || metadata.base_ref
      || metadata.target_ref
      || metadata.target_branch
      || (metadata.worktree && metadata.worktree.base)
  );
  if (named && resolveRef(root, named)) return named;
  return BASE_CANDIDATES.find(ref => resolveRef(root, ref)) || null;
}

function mergeCheck(root, row) {
  const metadata = parsedMetadata(row);
  const branch = branchOf(metadata);
  if (!branch) return null;
  const tip = resolveRef(root, branch) || resolveRef(root, `origin/${branch}`);
  if (!tip) return null;
  const base = baseOf(root, metadata);
  if (!base) return null;
  const baseTip = resolveRef(root, base);
  if (!baseTip) return null;
  const tipTime = Number(git(root, ['log', '-1', '--format=%ct', tip]).out);
  const createdSec = Math.floor(Number(row.created_at || 0) / 1000);
  if (!Number.isFinite(tipTime) || tipTime < createdSec) return null;
  if (!git(root, ['merge-base', '--is-ancestor', tip, baseTip]).ok) return null;
  return { branch, base, sha: tip };
}

function closeMergedTasks(db, { workspaceRoot, gitRoot = workspaceRoot, actor } = {}) {
  const who = actor || process.env.ATRIS_AGENT_ID || process.env.USER || 'task-list';
  const rows = db.prepare(
    "SELECT id, title, status, tag, created_at, metadata FROM tasks WHERE workspace_root = ? AND status = 'review'"
  ).all(workspaceRoot);
  const closed = [];
  for (const row of rows) {
    if (protectedLaneOf({ ...row, metadata: parsedMetadata(row) })) continue;
    const merged = mergeCheck(gitRoot, row);
    if (!merged) continue;
    const result = taskDb.doneTask(db, {
      id: row.id,
      status: 'done',
      actor: who,
      allowReview: true,
      action: 'merged',
      proof: `branch ${merged.branch} at ${merged.sha.slice(0, 12)} is merged into ${merged.base}`,
    });
    if (result.updated) closed.push({ id: row.id, title: row.title, ...merged });
  }
  return { closed };
}

module.exports = {
  closeMergedTasks,
  mergeCheck,
};

'use strict';

const { spawnSync } = require('child_process');

// A member that passed its check but never committed leaves its work loose in
// a side checkout that cleanup later deletes (member lab 2026-10-24: navigator
// and validator wrote the right files, said done, committed nothing). Commit
// what is left so the branch holds the work. Atris's own state stays out.
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: String(result.stdout || '').trim() };
}

function jobForbidsCommit(text) {
  return /\b(do\s+not|don't|never|without)\s+(create\s+an?\s+|make\s+an?\s+)?commit/i.test(String(text || ''));
}

function saveLeftoverMemberWork({ worktreePath, member = 'member', objective = '' } = {}) {
  if (!worktreePath) return { saved: false, reason: 'no_worktree' };
  // The job's own words win: "do not commit" means leave the changes loose.
  if (jobForbidsCommit(objective)) return { saved: false, reason: 'job_forbids_commit' };
  if (!git(['rev-parse', '--is-inside-work-tree'], worktreePath).ok) return { saved: false, reason: 'not_git' };
  const add = git(['add', '-A', '--', '.', ':(exclude).atris', ':(exclude).agent-worktrees'], worktreePath);
  if (!add.ok) return { saved: false, reason: 'add_failed' };
  const staged = git(['diff', '--cached', '--name-only'], worktreePath).stdout.split('\n').filter(Boolean);
  if (!staged.length) return { saved: false, reason: 'nothing_left' };
  const title = String(objective || '').split('\n').map((line) => line.trim()).find(Boolean) || 'finished work';
  const message = `${member}: ${title.slice(0, 72)}\n\nSaved by atris after the check passed; the member left these changes uncommitted.`;
  const commit = git(['commit', '-q', '-m', message], worktreePath);
  if (!commit.ok) return { saved: false, reason: 'commit_failed', files: staged };
  return { saved: true, files: staged, sha: git(['rev-parse', 'HEAD'], worktreePath).stdout };
}

module.exports = { jobForbidsCommit, saveLeftoverMemberWork };

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
  return /\b(do\s+not|don't|never|without|no)\s+(?:[a-z]+\s+){0,3}commit/i.test(String(text || ''));
}

// Files that look like secrets never ride an automatic commit.
const SECRET_PATH = /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|[^/]*credentials?[^/]*\.(json|ya?ml|txt)|secrets?\.(json|ya?ml|txt|env)|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*|service[-_]account[^/]*\.json)$/i;

function saveLeftoverMemberWork({ worktreePath, member = 'member', objective = '' } = {}) {
  if (!worktreePath) return { saved: false, reason: 'no_worktree' };
  // The job's own words win: "do not commit" means leave the changes loose.
  if (jobForbidsCommit(objective)) return { saved: false, reason: 'job_forbids_commit' };
  if (!git(['rev-parse', '--is-inside-work-tree'], worktreePath).ok) return { saved: false, reason: 'not_git' };
  // Only a linked side checkout: its git dir differs from the shared one. The
  // person's main checkout is never committed into.
  const gitDir = git(['rev-parse', '--absolute-git-dir'], worktreePath).stdout;
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath).stdout;
  if (!gitDir || !commonDir || gitDir === commonDir) return { saved: false, reason: 'not_side_checkout' };
  const add = git(['add', '-A', '--', '.', ':(exclude).atris', ':(exclude).agent-worktrees'], worktreePath);
  if (!add.ok) return { saved: false, reason: 'add_failed' };
  git(['reset', '-q', '--', '.atris', '.agent-worktrees'], worktreePath);
  const stagedAll = git(['diff', '--cached', '--name-only'], worktreePath).stdout.split('\n').filter(Boolean);
  const skipped = stagedAll.filter((file) => SECRET_PATH.test(file));
  if (skipped.length) git(['reset', '-q', '--', ...skipped], worktreePath);
  const staged = stagedAll.filter((file) => !SECRET_PATH.test(file));
  if (!staged.length) return { saved: false, reason: 'nothing_left', ...(skipped.length ? { skipped } : {}) };
  const title = String(objective || '').split('\n').map((line) => line.trim()).find(Boolean) || 'finished work';
  const message = `${member}: ${title.slice(0, 72)}\n\nSaved by atris after the check passed; the member left these changes uncommitted.`;
  const commit = git(['commit', '-q', '-m', message], worktreePath);
  if (!commit.ok) return { saved: false, reason: 'commit_failed', files: staged };
  return { saved: true, files: staged, ...(skipped.length ? { skipped } : {}), sha: git(['rev-parse', 'HEAD'], worktreePath).stdout };
}

module.exports = { jobForbidsCommit, saveLeftoverMemberWork };

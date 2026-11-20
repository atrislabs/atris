'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TRAILER } = require('../commands/sign');

// A member that passed its check but never committed leaves its work loose in
// a side checkout that cleanup later deletes (member lab 2026-10-24: navigator
// and validator wrote the right files, said done, committed nothing). Commit
// what is left so the branch holds the work. Atris's own state stays out.
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: String(result.stdout || '').trim() };
}

function jobForbidsCommit(text) {
  return /\b(do\s+not|don't|never|without|no)\s+(?:(?:create|make|add|any|new|a|an|more)\s+){0,3}commit/i.test(String(text || ''));
}

// Files that look like secrets never ride an automatic commit.
const SECRET_PATH = /(^|\/)(\.(aws|ssh|gnupg|docker|kube)\/|\.env(\.[^/]*)?$|\.npmrc$|\.netrc$|credentials?$|[^/]*credentials?[^/]*\.(json|ya?ml|txt)$|secrets?\.(json|ya?ml|txt|env)$|[^/]*\.(pem|key|p12|pfx)$|id_(rsa|ed25519|ecdsa)[^/]*$|service[-_]account[^/]*\.json$)/i;

function saveLeftoverMemberWork({ worktreePath, member = 'member', objective = '' } = {}) {
  if (!worktreePath) return { saved: false, reason: 'no_worktree' };
  // The job's own words win: "do not commit" means leave the changes loose.
  if (jobForbidsCommit(objective)) return { saved: false, reason: 'job_forbids_commit' };
  if (!git(['rev-parse', '--is-inside-work-tree'], worktreePath).ok) return { saved: false, reason: 'not_git' };
  // Only a linked side checkout: its git dir differs from the shared one. The
  // person's main checkout is never committed into.
  // Plain --git-dir/--git-common-dir work on old git too; resolve both against
  // the checkout, since either may come back relative.
  const gitDirOut = git(['rev-parse', '--git-dir'], worktreePath).stdout;
  const commonDirOut = git(['rev-parse', '--git-common-dir'], worktreePath).stdout;
  if (!gitDirOut || !commonDirOut) return { saved: false, reason: 'not_side_checkout' };
  const real = (dir) => { try { return fs.realpathSync(path.resolve(worktreePath, dir)); } catch { return ''; } };
  const gitDir = real(gitDirOut);
  const commonDir = real(commonDirOut);
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
  const message = `${member}: ${title.slice(0, 72)}\n\nSaved by atris after the check passed; the member left these changes uncommitted.\n\n${TRAILER}`;
  const commit = git(['commit', '-q', '-m', message], worktreePath);
  if (!commit.ok) return { saved: false, reason: 'commit_failed', files: staged };
  return { saved: true, files: staged, ...(skipped.length ? { skipped } : {}), sha: git(['rev-parse', 'HEAD'], worktreePath).stdout };
}

// The member's standing mission (its own MISSION.md, plus the shared atris/MISSION.md when it points
// there) limits a job as much as the job's own words. Seen live 2026-11-17: three members whose
// mission says "no merges" were woken in private copies and told to commit and push.
function memberStandingMission(owner, root) {
  const files = standingMissionFiles(owner, root);
  const own = files.own || '';
  return own && /\batris\/MISSION\.md\b/i.test(own) && files.shared ? `${own}\n${files.shared}` : own;
}

// The two files a member's standing words come from, read as they are: its
// own MISSION.md and the project's shared atris/MISSION.md. '' when a file is
// missing, null when it is there but cannot be read.
function standingMissionFiles(owner, root) {
  const name = String(owner || '').trim();
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { return error.code === 'ENOENT' ? '' : null; } };
  const shared = read(path.join(root, 'atris', 'MISSION.md'));
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return { own: '', shared };
  const dir = require('./mission-core').memberDir(name, root) || path.join(root, 'atris', 'team', name);
  return { own: read(path.join(dir, 'MISSION.md')), shared };
}

// True when the job's words or the member's standing mission forbid commit, push or merge.
function memberForbidsLanding(owner, objective, root) {
  return [objective, memberStandingMission(owner, root)].some((text) =>
    jobForbidsCommit(String(text || '').replace(/\b(?:push|merge)/gi, 'commit')));
}

module.exports = { jobForbidsCommit, memberForbidsLanding, memberStandingMission, saveLeftoverMemberWork, standingMissionFiles };

'use strict';

// The one rule for the word "landed".
//
// Before this module, "landed" meant whatever the writer had in hand. The
// autoland receipt called every accepted task landed. On 2026-10-14 the 07:14
// tick receipt listed AIT-5..AIT-8 as landed; their commits (50282f7c,
// bcb20291, ...) sat on a worktree branch and never reached origin/master.
// OBL-3213 "landed" after its verifier ran a test file out of a different
// worktree (executor-operate) while the repo's own checkout never had the
// change. Across the 537 auto-accepts in the last 30 days that recorded the
// commit their check ran on, 72 ran on a commit that never reached the target
// branch and 137 more ran on a commit older than the task itself, so the check
// could not have seen the work. 80 more were "verified" by `git diff --check`,
// which passes on an empty diff.
//
// So a receipt may say "landed" only when all of this holds:
//   1. the commit is on the target branch (origin's copy when there is one);
//   2. the change from `base` to the commit is non-empty and touches every
//      file the work claims;
//   3. the check behind it ran on committed, tracked content and is a check
//      that can fail.
// Anything else is recorded as what it is: not_landed, no_op, or unverified.

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git-spawn');
const { nonFalsifyingIssue } = require('./accept-verify-gate');

// Task bookkeeping that every loop rewrites in place; a dirty TODO.md says
// nothing about the code a verifier ran.
const BOOKKEEPING_PATH = /^(?:atris|\.atris)\//;

function git(root, args) {
  const result = runGit(args, { cwd: root, check: false });
  return { ok: result.status === 0, out: String(result.stdout || '').trim() };
}

function resolveCommit(root, ref) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok && result.out ? result.out : null;
}

// Origin's copy of the branch is the truth: a commit only on a local master
// has not landed anywhere anyone else can see.
function resolveTarget(root, target) {
  const name = String(target || '').trim();
  // A full ref is an explicit choice (a caller that just moved a local
  // branch on purpose); check exactly that.
  if (name.startsWith('refs/')) return resolveCommit(root, name) ? name : null;
  const candidates = name
    ? [name.startsWith('origin/') ? name : `origin/${name}`, name]
    : ['origin/HEAD', 'origin/master', 'origin/main', 'master', 'main'];
  for (const ref of candidates) {
    if (resolveCommit(root, ref)) return ref;
  }
  return null;
}

function verdict(status, reason, detail, extra = {}) {
  return { status, reason, detail, ...extra };
}

// Paths a verify command names, checked against what git actually tracks.
// A check that runs a file outside this checkout, or a file git does not
// have committed, proves nothing about the commit. The program itself
// (node, a venv python) is a tool, not the work, so it is not checked.
function verifyPathIssue(command, cwd, top) {
  let dir = cwd;
  for (const segment of String(command || '').split('&&')) {
    const argv = segment.trim().split(/\s+/)
      .map((token) => token.replace(/^['"`]|['"`;]$/g, ''))
      .filter(Boolean);
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
    if (argv[0] === 'cd') {
      if (argv[1]) dir = path.resolve(dir, argv[1]);
      continue;
    }
    for (const token of argv.slice(1)) {
      if (token.startsWith('-') || token.includes('=')) continue;
      if (!(path.isAbsolute(token) || token.startsWith('~') || token.includes('/'))) continue;
      const named = token.startsWith('~')
        ? path.join(process.env.HOME || '', token.slice(1))
        : path.resolve(dir, token);
      if (!fs.existsSync(named)) continue;
      const relative = path.relative(top, fs.realpathSync(named));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return `the check runs ${token}, which lives outside this checkout`;
      }
      if (!relative) continue;
      if (!git(top, ['ls-files', '--error-unmatch', '--', relative]).ok) {
        return `the check runs ${relative}, which git does not track`;
      }
      if (!git(top, ['diff', '--quiet', 'HEAD', '--', relative]).ok) {
        return `the check runs ${relative}, which has uncommitted changes`;
      }
    }
  }
  return '';
}

function uncommittedChanges(top) {
  const status = git(top, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return [];
  return status.out.split('\n').filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .filter((file) => !BOOKKEEPING_PATH.test(file));
}

// root: where the check ran. commit: what it ran on (default HEAD).
// base: the target as it stood before this work. files: what the work claims
// to change. verify: the check command. checkedWorkingTree: the check ran in
// root's working tree (not a clean scratch copy), so uncommitted files count.
function proveLanding(root, { commit = 'HEAD', base = '', target = '', files = [], verify = '', checkedWorkingTree = false } = {}) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.out) return verdict('unverified', 'not_a_git_checkout', `${root} is not a git checkout`);
  // git reports the resolved path (/private/var on macOS); compare like with like.
  const cwd = fs.realpathSync(root);
  const sha = resolveCommit(top.out, commit);
  if (!sha) return verdict('unverified', 'commit_missing', `commit ${commit} does not exist here`);
  const targetRef = resolveTarget(top.out, target);
  if (!targetRef) return verdict('not_landed', 'no_target_branch', 'no target branch to land on', { commit: sha });
  const facts = { commit: sha, target: targetRef };

  if (!git(top.out, ['merge-base', '--is-ancestor', sha, targetRef]).ok) {
    return verdict('not_landed', 'commit_not_on_target', `${sha.slice(0, 9)} is not on ${targetRef}`, facts);
  }

  const baseSha = base ? resolveCommit(top.out, base) : null;
  if (!baseSha) return verdict('unverified', 'no_base', 'nothing to measure the change against', facts);
  const diff = git(top.out, ['diff', '--name-only', `${baseSha}..${sha}`]);
  const changed = diff.ok ? diff.out.split('\n').filter(Boolean) : [];
  const atOrBeforeBase = git(top.out, ['merge-base', '--is-ancestor', sha, baseSha]).ok;
  if (atOrBeforeBase || changed.length === 0) {
    return verdict('no_op', 'empty_diff', `${sha.slice(0, 9)} carries no change past ${baseSha.slice(0, 9)}`, { ...facts, base: baseSha });
  }
  Object.assign(facts, { base: baseSha, changed_files: changed.slice(0, 50) });

  const claimed = files.map((file) => {
    const relative = path.relative(top.out, path.resolve(cwd, String(file)));
    return relative.replace(/\\/g, '/');
  }).filter((file) => file && !file.startsWith('..'));
  const untouched = claimed.filter((file) => !changed.some((c) => c === file || c.startsWith(`${file}/`)));
  if (untouched.length) {
    return verdict('unverified', 'claimed_files_untouched', `the change does not touch ${untouched.slice(0, 5).join(', ')}`, facts);
  }

  const command = String(verify || '').trim();
  if (!command) return verdict('unverified', 'no_check', 'no check ran on this change', facts);
  const hollow = nonFalsifyingIssue(command);
  if (hollow) return verdict('unverified', 'check_cannot_fail', hollow, facts);
  if (checkedWorkingTree) {
    const dirty = uncommittedChanges(top.out);
    if (dirty.length) {
      return verdict('unverified', 'checked_uncommitted_files', `the check ran with uncommitted files present: ${dirty.slice(0, 5).join(', ')}`, facts);
    }
    const pathIssue = verifyPathIssue(command, cwd, top.out);
    if (pathIssue) return verdict('unverified', 'checked_untracked_content', pathIssue, facts);
  }
  return verdict('landed', 'proven', '', facts);
}

// A task's work starts when it is first claimed; the target as it stood then
// is the base the change is measured from.
function taskStartedAt(task) {
  const claims = (Array.isArray(task.events) ? task.events : [])
    .filter((event) => event && event.event_type === 'claimed')
    .map((event) => Number(event.created_at) || Date.parse(event.created_at) || 0)
    .filter(Boolean);
  return claims.length ? Math.min(...claims) : Number(task.created_at) || 0;
}

// The verifier just ran in the task's workspace at its HEAD; this asks
// whether that HEAD is a real change on the target branch.
function proveTaskLanding(task, { files = [] } = {}) {
  const root = task.workspace_root || process.cwd();
  const metadata = task.metadata || {};
  const target = resolveTarget(root, metadata.target_branch || metadata.base_ref || '');
  const startedAt = taskStartedAt(task);
  const base = target && startedAt
    ? git(root, ['rev-list', '-1', '--first-parent', `--before=${Math.floor(startedAt / 1000)}`, target]).out
    : '';
  return proveLanding(root, {
    commit: 'HEAD',
    base,
    target: target || '',
    files,
    verify: metadata.verify,
    checkedWorkingTree: true,
  });
}

module.exports = {
  proveLanding,
  proveTaskLanding,
};

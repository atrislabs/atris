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
//   1. the work's own commit has a non-empty change from its base, and every
//      file it changed reads the same on origin's target branch (or a later
//      version that grew from it). Content, not commit ids: squash, rebase and
//      merge-queue merges rewrite ids, so ancestry is only the fast path;
//   2. the change touches every tracked file the work claims;
//   3. the check behind it can fail, and ran on a checkout that held the work
//      with those files committed.
// Anything else is recorded as what it is: not_landed, no_op, or unverified.
// A repo with no fetched origin target is unverified: a local branch is not
// somewhere anyone else can see the work.

const fs = require('fs');
const path = require('path');
const { runGit } = require('./git-spawn');
const { nonFalsifyingIssue } = require('./accept-verify-gate');

const SHA = /^[0-9a-f]{40}$/;
const MAX_HISTORY_SCAN = 50;

function git(root, args) {
  const result = runGit(args, { cwd: root, check: false });
  return { ok: result.status === 0, out: String(result.stdout || '').trim() };
}

// Answers about fixed commit ids never change, so they are cached for the
// life of the process. One heartbeat proves hundreds of tasks against the
// same few commits; without this a 500-task sweep cost ~7,000 git spawns.
// Anything that reads a ref or the working tree is never cached.
const immutable = new Map();
function gitFixed(top, args) {
  const key = `${top}\u0000${args.join('\u0000')}`;
  if (immutable.has(key)) return immutable.get(key);
  const result = git(top, args);
  if (immutable.size > 20000) immutable.clear();
  immutable.set(key, result);
  return result;
}

const toplevels = new Map();
function toplevel(root) {
  const key = path.resolve(root);
  if (!toplevels.has(key)) {
    const top = git(root, ['rev-parse', '--show-toplevel']);
    toplevels.set(key, top.ok && top.out ? top.out : null);
  }
  return toplevels.get(key);
}

function resolveCommit(top, ref) {
  const text = String(ref || '').trim();
  if (!text) return null;
  const args = ['rev-parse', '--verify', '--quiet', `${text}^{commit}`];
  const result = SHA.test(text) ? gitFixed(top, args) : git(top, args);
  return result.ok && result.out ? result.out : null;
}

function isAncestor(top, older, newer) {
  return gitFixed(top, ['merge-base', '--is-ancestor', older, newer]).ok;
}

function blobAt(top, sha, file) {
  const result = gitFixed(top, ['rev-parse', '--verify', '--quiet', `${sha}:${file}`]);
  return result.ok && result.out ? result.out : null;
}

// Only origin's copy counts. A full ref is an explicit choice by a caller
// that just moved that ref itself (the green lander with no remote).
function resolveTarget(top, target) {
  const name = String(target || '').trim();
  if (name.startsWith('refs/')) return resolveCommit(top, name) ? name : null;
  const branch = name.replace(/^origin\//, '');
  const candidates = branch ? [`origin/${branch}`] : ['origin/HEAD', 'origin/master', 'origin/main'];
  return candidates.find((ref) => resolveCommit(top, ref)) || null;
}

function verdict(status, reason, detail, extra = {}) {
  return { status, reason, detail, ...extra };
}

// A changed file reached the target when the target holds the same content,
// or a later version whose history passes through that content (someone
// edited it again after the squash landed).
function contentReached(top, base, sha, targetSha, file) {
  const mine = blobAt(top, sha, file);
  const theirs = blobAt(top, targetSha, file);
  if (mine === theirs) return true;
  const history = gitFixed(top, ['log', '--format=%H', `-${MAX_HISTORY_SCAN}`, `${base}..${targetSha}`, '--', file]);
  if (!history.ok) return false;
  return history.out.split('\n').filter(Boolean).some((commit) => blobAt(top, commit, file) === mine);
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
      if (!(path.isAbsolute(token) || token.startsWith('~') || token.includes('/') || /\.[A-Za-z0-9]+$/.test(token))) continue;
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

// Artifact paths a task names (receipts, run logs) are often gitignored or
// never committed. They cannot be part of a landing, so they are not held
// against one.
function trackableClaims(top, cwd, sha, changed, files) {
  const claimed = [];
  for (const file of files) {
    const relative = path.relative(top, path.resolve(cwd, String(file))).replace(/\\/g, '/');
    if (!relative || relative.startsWith('..')) continue;
    if (changed.some((c) => c === relative || c.startsWith(`${relative}/`))) {
      claimed.push(relative);
      continue;
    }
    if (git(top, ['check-ignore', '-q', '--', relative]).ok) continue;
    const known = gitFixed(top, ['ls-tree', '--name-only', sha, '--', relative]);
    if (!known.ok || !known.out) continue;
    claimed.push(relative);
  }
  return claimed;
}

// root: where the check ran. commit: the work's own commit. start: the
// commit the work began from, when recorded. base: an explicit base (the
// green lander knows the target it merged onto). files: what the work claims
// to change. verify: the check command. checkedWorkingTree: the check ran in
// root's working tree, so that tree must hold the work, committed.
function proveLanding(root, { commit = 'HEAD', start = '', base = '', target = '', files = [], verify = '', checkedWorkingTree = false } = {}) {
  const top = toplevel(root);
  if (!top) return verdict('unverified', 'not_a_git_checkout', `${root} is not a git checkout`);
  // git reports the resolved path (/private/var on macOS); compare like with like.
  const cwd = fs.realpathSync(root);
  const sha = resolveCommit(top, commit);
  if (!sha) return verdict('unverified', 'commit_missing', `commit ${commit} does not exist here`);
  const targetRef = resolveTarget(top, target);
  if (!targetRef) {
    return verdict('unverified', 'no_remote_target', `no fetched origin branch${target ? ` for ${target}` : ''} to prove the landing against`, { commit: sha });
  }
  const targetSha = resolveCommit(top, targetRef);
  const facts = { commit: sha, target: targetRef };

  const startSha = start ? resolveCommit(top, start) : null;
  let baseSha = base ? resolveCommit(top, base) : null;
  if (!baseSha && startSha && isAncestor(top, startSha, sha)) baseSha = startSha;
  if (!baseSha) {
    const forked = gitFixed(top, ['merge-base', sha, targetSha]);
    baseSha = forked.ok && forked.out && forked.out !== sha ? forked.out : null;
  }
  if (!baseSha) {
    return verdict('unverified', 'no_base', `${sha.slice(0, 9)} is already on ${targetRef} and the work recorded no start, so its own change cannot be measured`, facts);
  }
  const diff = gitFixed(top, ['diff', '--name-only', `${baseSha}..${sha}`]);
  const changed = diff.ok ? diff.out.split('\n').filter(Boolean) : [];
  if (changed.length === 0 || isAncestor(top, sha, baseSha)) {
    return verdict('no_op', 'empty_diff', `${sha.slice(0, 9)} carries no change past ${baseSha.slice(0, 9)}`, { ...facts, base: baseSha });
  }
  Object.assign(facts, { base: baseSha, changed_files: changed.slice(0, 50) });

  if (!isAncestor(top, sha, targetSha)) {
    const missing = changed.filter((file) => !contentReached(top, baseSha, sha, targetSha, file));
    if (missing.length) {
      return verdict('not_landed', 'content_not_on_target', `${targetRef} does not hold this work's version of ${missing.slice(0, 5).join(', ')}`, facts);
    }
    facts.matched_by = 'content';
  }

  const claimed = trackableClaims(top, cwd, sha, changed, files);
  const untouched = claimed.filter((file) => !changed.some((c) => c === file || c.startsWith(`${file}/`)));
  if (untouched.length) {
    return verdict('unverified', 'claimed_files_untouched', `the change does not touch ${untouched.slice(0, 5).join(', ')}`, facts);
  }

  const command = String(verify || '').trim();
  if (!command) return verdict('unverified', 'no_check', 'no check ran on this change', facts);
  const hollow = nonFalsifyingIssue(command);
  if (hollow) return verdict('unverified', 'check_cannot_fail', hollow, facts);
  if (checkedWorkingTree) {
    const head = resolveCommit(top, 'HEAD');
    const holdsWork = head && (isAncestor(top, sha, head) || changed.every((file) => blobAt(top, head, file) === blobAt(top, sha, file)));
    if (!holdsWork) {
      return verdict('unverified', 'check_ran_without_the_work', `the check ran on ${head ? head.slice(0, 9) : 'an unknown commit'}, which does not hold this work`, facts);
    }
    const scope = [...new Set([...changed, ...claimed])];
    const dirty = git(top, ['status', '--porcelain', '--untracked-files=all', '--', ...scope]);
    if (dirty.ok && dirty.out) {
      const names = dirty.out.split('\n').map((line) => line.slice(3));
      return verdict('unverified', 'checked_uncommitted_files', `the check ran with uncommitted edits to ${names.slice(0, 5).join(', ')}`, facts);
    }
    const pathIssue = verifyPathIssue(command, cwd, top);
    if (pathIssue) return verdict('unverified', 'checked_untracked_content', pathIssue, facts);
  }
  return verdict('landed', 'proven', '', facts);
}

// A task proves its landing from its own commits: start_commit is stamped
// at claim, work_commit when the builder marks it ready. With no commit of
// its own there is nothing to prove, whatever the checkout's HEAD says.
function proveTaskLanding(task, { files = [] } = {}) {
  const metadata = task.metadata || {};
  const work = String(metadata.work_commit || '').trim();
  const start = String(metadata.start_commit || '').trim();
  if (!work) {
    return verdict('unverified', 'no_task_commit', 'the task recorded no commit of its own, so nothing can be proven landed');
  }
  if (start && work === start) {
    return verdict('no_op', 'no_commit_made', 'the task finished on the same commit it started from', { commit: work });
  }
  return proveLanding(task.workspace_root || process.cwd(), {
    commit: work,
    start,
    target: metadata.target_branch || metadata.base_ref || '',
    files,
    verify: metadata.verify,
    checkedWorkingTree: true,
  });
}

module.exports = {
  proveLanding,
  proveTaskLanding,
};

'use strict';

// `atris member tidy`: put away member copies of the repo (git worktrees under
// <arena>/.agent-worktrees/<repo>) whose work already landed. There is no
// deletion logic here on purpose. git does the removing with
// `git worktree remove` (never --force), which refuses modified or untracked
// files, then `git branch -d` (never -D). Everything this file decides is
// about which copies to leave alone:
//   - work not landed: branch tip is not an ancestor of origin's default
//     branch tip, asked of origin itself on every run. Listed with its age, never touched.
//   - any git error while deciding: skipped.
//   - a live process inside the copy (lsof). If the scan itself fails, every
//     copy is skipped.
//   - a copy whose real path is outside the real worktrees folder (a symlink).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectGitActivity, missingFolderLock } = require('./git-activity');
const { recordWorktreeRemoval } = require('../commands/worktree');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error?.message || '').trim(),
  };
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || 'no reason given';
}

function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

function mainRepoRoot(cwd) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common.ok) return null;
  return path.basename(common.stdout) === '.git' ? path.dirname(common.stdout) : common.stdout;
}

function defaultWorktreesDir(repoRoot) {
  return path.join(path.dirname(repoRoot), '.agent-worktrees', path.basename(repoRoot));
}

function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return entries;
}

// Ask origin itself which branch it ships from and where that branch is right
// now. The local origin/HEAD note goes stale when the default branch changes,
// so it is never trusted. Returns the exact commit to compare against.
function originDefaultTip(repoRoot) {
  const remote = git(['ls-remote', '--symref', 'origin', 'HEAD'], repoRoot);
  if (!remote.ok) return { ok: false, reason: `could not ask origin for its main branch: ${firstLine(remote.stderr)}` };
  const branch = remote.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m);
  if (!branch) return { ok: false, reason: 'could not tell which branch origin ships from' };
  const fetched = git(['fetch', '--quiet', 'origin', `refs/heads/${branch[1]}`], repoRoot);
  if (!fetched.ok) return { ok: false, reason: `could not fetch origin: ${firstLine(fetched.stderr)}` };
  // Judge against what was actually fetched, not what origin advertised a
  // moment earlier: the branch can move in between.
  const tip = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repoRoot);
  if (!tip.ok || !/^[0-9a-f]{40,64}$/.test(tip.stdout.trim())) return { ok: false, reason: 'could not read the fetched main branch' };
  return { ok: true, branch: branch[1], tip: tip.stdout.trim() };
}

// Every path any process has open (cwd included). Any failure means we cannot
// tell what is busy, so the caller skips all copies.
function scanOpenPaths(lsofBin = 'lsof') {
  const result = spawnSync(lsofBin, ['-n', '-P', '-w', '-F', 'n'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: firstLine(result.error?.message || result.stderr || `lsof exited ${result.status}`) };
  }
  const paths = [];
  for (const line of String(result.stdout || '').split('\n')) {
    if (line.startsWith('n/')) paths.push(line.slice(1));
  }
  return { ok: true, paths };
}

function hasLiveProcess(realCopy, openPaths) {
  return openPaths.some((p) => p === realCopy || p.startsWith(realCopy + path.sep));
}

function tidyMemberCopies(options = {}) {
  const now = options.now || Date.now();
  const dryRun = Boolean(options.dryRun);
  const repoRoot = options.repoRoot || mainRepoRoot(options.cwd || process.cwd());
  const result = { dryRun, worktreesDir: null, copies: [], removed: 0, kept: 0, aborted: null };
  if (!repoRoot) {
    result.aborted = 'not inside a git repo';
    return result;
  }
  const worktreesDir = path.resolve(options.worktreesDir || defaultWorktreesDir(repoRoot));
  result.worktreesDir = worktreesDir;
  let realDir;
  try {
    realDir = fs.realpathSync(worktreesDir);
  } catch {
    return result;
  }

  const listed = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!listed.ok) {
    result.aborted = `git could not list copies: ${firstLine(listed.stderr)}`;
    return result;
  }
  const copies = parseWorktreeList(listed.stdout)
    .filter((entry) => isUnder(entry.path, worktreesDir) || isUnder(entry.path, realDir));

  const keep = (copy, reason) => {
    result.copies.push({ ...copy, action: 'kept', reason });
    result.kept += 1;
  };

  const base = originDefaultTip(repoRoot);
  const scan = scanOpenPaths(options.lsofBin);
  let abortReason = null;
  if (!base.ok) abortReason = base.reason;
  else if (!scan.ok) abortReason = `could not check for running programs: ${scan.reason}`;
  if (abortReason) result.aborted = abortReason;

  const selfReal = (() => {
    try { return fs.realpathSync(options.cwd || process.cwd()); } catch { return null; }
  })();

  for (const entry of copies) {
    const copy = { name: path.basename(entry.path), path: entry.path, branch: entry.branch };
    let realCopy;
    try {
      realCopy = fs.realpathSync(entry.path);
    } catch {
      const lock = missingFolderLock(repoRoot, entry.path, now);
      keep(copy, lock.locks.length ? lock.reason : 'folder is missing');
      continue;
    }
    if (!isUnder(realCopy, realDir)) {
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `points outside the copies folder, left alone${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    if (abortReason) {
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `${abortReason}${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    if (!entry.branch) {
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `not on a branch${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    const ancestor = git(['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, base.tip], repoRoot);
    if (ancestor.status === 1) {
      let age = '';
      try {
        const stat = fs.statSync(realCopy);
        age = `, ${formatAge(now - (stat.birthtimeMs || stat.mtimeMs))}`;
      } catch {}
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `work not landed yet${age}${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    if (!ancestor.ok) {
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `git could not tell if it landed: ${firstLine(ancestor.stderr)}${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    if ((selfReal && (selfReal === realCopy || isUnder(selfReal, realCopy)))
      || hasLiveProcess(realCopy, scan.paths)) {
      const activity = inspectGitActivity(realCopy, now);
      keep(copy, `landed, but something is still running inside it${activity.safe ? '' : `; ${activity.reason}`}`);
      continue;
    }
    const activity = inspectGitActivity(realCopy, now);
    // The folder can disappear during or after the git check. Git still exits
    // 0 removing a missing folder, so look on disk before removing.
    const missing = !fs.existsSync(entry.path);
    if (!activity.safe || missing) {
      if (missing) {
        const lock = missingFolderLock(repoRoot, entry.path, now);
        keep(copy, lock.locks.length ? lock.reason : 'folder is missing');
      } else {
        keep(copy, activity.reason);
      }
      continue;
    }
    if (dryRun) {
      result.copies.push({ ...copy, action: 'would remove', reason: 'work landed' });
      result.removed += 1;
      continue;
    }
    const removed = git(['worktree', 'remove', entry.path], repoRoot);
    if (!removed.ok) {
      // The folder can also move while git refuses; its locks still apply.
      const missingNow = !fs.existsSync(entry.path);
      const retained = missingNow ? missingFolderLock(repoRoot, entry.path, now) : inspectGitActivity(realCopy, now);
      const detail = retained.locks.length ? retained.reason : missingNow ? 'folder is missing' : '';
      keep(copy, `landed, but git refused: ${firstLine(removed.stderr)}${detail ? `; ${detail}` : ''}`);
      continue;
    }
    recordWorktreeRemoval(repoRoot, { path: entry.path, branch: entry.branch, by: 'atris member tidy', reason: 'branch_landed' });
    const branchGone = git(['branch', '-d', entry.branch], repoRoot);
    result.copies.push({
      ...copy,
      action: 'removed',
      reason: branchGone.ok ? 'work landed, branch deleted' : `work landed, branch kept: ${firstLine(branchGone.stderr)}`,
    });
    result.removed += 1;
  }
  return result;
}

function formatTidy(result) {
  const lines = [];
  if (!result.worktreesDir) {
    lines.push(`tidy: ${result.aborted || 'nothing to do'}`);
    return lines.join('\n');
  }
  if (result.aborted) lines.push(`tidy: ${result.aborted}, so every copy is kept`);
  const width = Math.max(0, ...result.copies.map((copy) => copy.action.length));
  for (const copy of result.copies) {
    lines.push(`${copy.action.padEnd(width)}  ${copy.name}  ${copy.reason}`);
  }
  const total = result.copies.length;
  const verb = result.dryRun ? 'would remove' : 'removed';
  lines.push(total
    ? `tidy: ${verb} ${result.removed}, kept ${result.kept}, of ${total} ${total === 1 ? 'copy' : 'copies'} in ${result.worktreesDir}`
    : `tidy: no member copies in ${result.worktreesDir}`);
  return lines.join('\n');
}

module.exports = {
  tidyMemberCopies,
  formatTidy,
};

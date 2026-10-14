'use strict';

// `atris member tidy`: put away member copies of this repo that live under
// <parent>/.agent-worktrees/<repo>/. Merged copies are removed with their local
// branch; old unmerged copies are pushed to origin as backup/<branch> first.
// Copies in use or holding uncommitted changes are left alone. Removal only
// ever goes through `git worktree remove`, never a raw delete.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  return {
    ok: result.status === 0,
    raw: String(result.stdout || ''),
    out: String(result.stdout || '').trim(),
    err: String(result.stderr || result.error?.message || '').trim(),
  };
}

function realish(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listWorktrees(root) {
  const res = git(['worktree', 'list', '--porcelain'], root);
  if (!res.ok) return [];
  const out = [];
  let current = null;
  for (const line of `${res.out}\n`.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, locked: false };
      out.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (current && line.startsWith('locked')) {
      current.locked = true;
    }
  }
  return out;
}

// The first worktree git lists is the main checkout, even when run from a copy.
function mainCheckout(cwd) {
  const list = listWorktrees(cwd);
  return list.length ? list[0].path : null;
}

function worktreesFolder(mainRoot) {
  return path.join(path.dirname(mainRoot), '.agent-worktrees', path.basename(mainRoot));
}

// Ask origin itself which branch is default and where it points. The local
// origin/HEAD is only a memory from clone time and goes stale when the remote
// switches defaults, which would make unmerged work look merged.
function remoteDefault(root) {
  const res = git(['ls-remote', '--symref', 'origin', 'HEAD'], root);
  if (!res.ok) return null;
  const ref = res.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m);
  const sha = res.out.match(/^([0-9a-f]{40,64})\s+HEAD$/m);
  if (!ref || !sha) return null;
  return { name: `origin/${ref[1]}`, sha: sha[1] };
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Process ids written by the run that owns the copy: mission lock files and
// the copy's sidecar both record them.
function recordedPids(copyPath) {
  const pids = [];
  const files = [path.join(copyPath, '.atris', 'agent-worktree.json')];
  const stateDir = path.join(copyPath, '.atris', 'state');
  try {
    for (const name of fs.readdirSync(stateDir)) {
      if (name.endsWith('.lock') || name.startsWith('progress')) files.push(path.join(stateDir, name));
    }
  } catch {}
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of ['pid', 'driver_pid']) if (data && data[key]) pids.push(Number(data[key]));
    } catch {}
  }
  return pids;
}

// Every running process's working folder, from lsof (macOS and Linux).
// Returns null when the scan fails, errors, or sees nothing at all: a failed
// scan is never read as "no process", so every copy is kept.
function processCwds() {
  const res = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
  if (res.error || res.status !== 0 || res.signal) return null;
  const rows = [];
  let pid = null;
  for (const line of String(res.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) rows.push({ pid, cwd: line.slice(1) });
  }
  return rows.length ? rows : null;
}

function livePid(copyPath, cwds) {
  const alive = recordedPids(copyPath).find((pid) => pid !== process.pid && pidAlive(pid));
  if (alive) return alive;
  const real = realish(copyPath);
  const hit = cwds.find((row) => {
    const cwd = realish(row.cwd);
    return cwd === real || isInside(real, cwd);
  });
  return hit ? hit.pid : null;
}

// Uncommitted work in a copy. Untracked files are always listed, whatever the
// repo's status.showUntrackedFiles says, and files git was told to stop
// watching (assume-unchanged, lowercase tag; skip-worktree, 'S') count as
// changed because their edits are invisible to status. null = could not tell.
function changedFiles(copyPath) {
  const res = git(['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], copyPath);
  if (!res.ok) return null;
  const changed = res.raw.split('\n').filter(Boolean).map((line) => line.slice(3));
  const flags = git(['ls-files', '-v'], copyPath);
  if (!flags.ok) return null;
  for (const line of flags.raw.split('\n')) {
    const tag = line.charAt(0);
    if (line.length > 2 && (tag === 'S' || /[a-z]/.test(tag))) changed.push(line.slice(2));
  }
  return changed;
}

// Why a copy's path is unsafe to touch, or null when it is safe. The real
// path must sit inside the real copies folder, and no step from the folder
// down to the copy may be a symlink.
function pathProblem(copyPath, folder, realFolder) {
  let real;
  try { real = fs.realpathSync(copyPath); } catch { return 'could not resolve its real folder'; }
  if (!isInside(realFolder, real)) return 'outside the member copies folder';
  const lexical = path.resolve(copyPath);
  const base = [realFolder, folder].find((dir) => isInside(dir, lexical));
  if (!base) return 'outside the member copies folder';
  let step = realFolder;
  for (const part of path.relative(base, lexical).split(path.sep)) {
    step = path.join(step, part);
    try {
      if (fs.lstatSync(step).isSymbolicLink()) return 'its path goes through a symlink';
    } catch { return 'could not check its folder'; }
  }
  if (step !== real) return 'its path goes through a symlink';
  return null;
}

function tipOf(copyPath) {
  const res = git(['rev-parse', '--verify', 'HEAD^{commit}'], copyPath);
  return res.ok && res.out ? res.out : null;
}

// Right before removing: the copy must still be on the commit that was
// judged, its branch must still point there, and it must still be clean.
function changedSinceJudged(wt, root, tip) {
  if (tipOf(wt.path) !== tip) return 'a new commit arrived after the check';
  if (wt.branch) {
    const ref = git(['rev-parse', '--verify', `refs/heads/${wt.branch}`], root);
    if (!ref.ok || ref.out !== tip) return 'its branch moved after the check';
  }
  const changed = changedFiles(wt.path);
  if (changed === null) return 'git could not read this copy';
  if (changed.length) return 'it picked up uncommitted changes after the check';
  return null;
}

function ageDays(copyPath, now) {
  let newest = 0;
  const commit = git(['log', '-1', '--format=%ct'], copyPath);
  if (commit.ok && commit.out) newest = Number(commit.out) * 1000;
  try {
    const sidecar = JSON.parse(fs.readFileSync(path.join(copyPath, '.atris', 'agent-worktree.json'), 'utf8'));
    const created = Date.parse(sidecar.created_at);
    if (Number.isFinite(created)) newest = Math.max(newest, created);
  } catch {}
  return newest ? Math.floor((now - newest) / DAY_MS) : 0;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function tidyMemberCopies(cwd, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const maxDays = Number.isFinite(options.days) ? options.days : 7;
  const now = options.now || Date.now();
  const root = mainCheckout(cwd);
  if (!root) return { error: 'This folder is not inside a git repo.' };
  const folder = worktreesFolder(root);
  for (const dir of [path.dirname(folder), folder]) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return { error: `${dir} is a symlink, so nothing was removed.` };
    } catch {}
  }
  let realFolder = null;
  try { realFolder = fs.realpathSync(folder); } catch {}

  const live = remoteDefault(root);
  if (!live) return { error: 'Could not ask origin which branch is its main one, so nothing was removed.' };
  if (!options.noFetch) git(['fetch', '--quiet', 'origin'], root);
  if (!git(['cat-file', '-e', `${live.sha}^{commit}`], root).ok) {
    return { error: `This repo does not have the latest ${live.name} yet, so nothing was removed. Fetch and try again.` };
  }
  const base = live.name;

  const copies = realFolder
    ? listWorktrees(root).filter((wt) => [realish(wt.path), path.resolve(wt.path)].some((p) => isInside(realFolder, p) || isInside(folder, p)))
    : [];
  const cwds = copies.length ? processCwds() : [];
  const rows = [];

  for (const wt of copies) {
    const name = path.basename(wt.path);
    const row = { name, path: wt.path, branch: wt.branch };
    rows.push(row);

    if (!fs.existsSync(wt.path)) {
      Object.assign(row, { action: 'skipped', reason: 'folder is already gone, run git worktree prune' });
      continue;
    }
    // Hard guard: only real paths inside the worktrees folder are ever touched.
    const unsafe = pathProblem(wt.path, folder, realFolder);
    if (unsafe) {
      Object.assign(row, { action: 'skipped', reason: unsafe });
      continue;
    }
    if (!cwds) {
      Object.assign(row, { action: 'skipped', reason: 'could not check for running processes' });
      continue;
    }
    const pid = livePid(wt.path, cwds);
    if (pid) {
      Object.assign(row, { action: 'skipped', reason: `in use by running process ${pid}` });
      continue;
    }
    const changed = changedFiles(wt.path);
    if (changed === null) {
      Object.assign(row, { action: 'skipped', reason: 'git could not read this copy' });
      continue;
    }
    if (changed.length) {
      const shown = changed.slice(0, 5).join(', ');
      const more = changed.length > 5 ? ` and ${changed.length - 5} more` : '';
      Object.assign(row, { action: 'skipped', reason: `has uncommitted changes: ${shown}${more}`, changed });
      continue;
    }
    if (wt.locked) {
      Object.assign(row, { action: 'skipped', reason: 'git has this copy locked' });
      continue;
    }

    const tip = tipOf(wt.path);
    if (!tip) {
      Object.assign(row, { action: 'skipped', reason: 'git could not read this copy' });
      continue;
    }
    const merged = git(['merge-base', '--is-ancestor', tip, live.sha], wt.path).ok;
    const days = ageDays(wt.path, now);
    row.days = days;

    if (merged) {
      row.action = 'removed';
      row.reason = `merged into ${base.replace(/^origin\//, '')}`;
      if (dryRun) continue;
      const moved = changedSinceJudged(wt, root, tip);
      if (moved) {
        Object.assign(row, { action: 'kept', reason: `${moved}, copy and branch kept` });
        continue;
      }
      const removed = git(['worktree', 'remove', wt.path], root);
      if (!removed.ok) {
        Object.assign(row, { action: 'failed', reason: `git would not remove it: ${removed.err.split('\n')[0]}` });
        continue;
      }
      if (wt.branch) {
        // Lowercase -d: git itself refuses if the branch is not fully merged.
        const del = git(['branch', '-d', wt.branch], root);
        row.reason += del.ok ? ', local branch deleted' : ', local branch kept';
      }
      continue;
    }

    if (days < maxDays) {
      Object.assign(row, { action: 'kept', reason: `not merged, ${plural(days, 'day')} old` });
      continue;
    }
    if (!wt.branch) {
      Object.assign(row, { action: 'kept', reason: `not merged and has no branch to back up, ${plural(days, 'day')} old` });
      continue;
    }

    const backup = `backup/${wt.branch}`;
    row.action = 'backed up';
    row.backup = backup;
    row.reason = `not merged, ${plural(days, 'day')} old, saved to origin as ${backup}`;
    if (dryRun) continue;
    const pushed = git(['push', '--quiet', 'origin', `${tip}:refs/heads/${backup}`], root);
    if (!pushed.ok) {
      Object.assign(row, { action: 'failed', reason: `backup push failed, copy kept: ${pushed.err.split('\n')[0]}` });
      continue;
    }
    const movedAfterBackup = changedSinceJudged(wt, root, tip);
    if (movedAfterBackup) {
      Object.assign(row, { action: 'kept', reason: `saved to origin as ${backup}, but ${movedAfterBackup}, copy kept` });
      continue;
    }
    const removed = git(['worktree', 'remove', wt.path], root);
    if (!removed.ok) {
      Object.assign(row, { action: 'failed', reason: `backed up as ${backup} but git would not remove it: ${removed.err.split('\n')[0]}` });
    }
  }

  const totals = { copies: rows.length, removed: 0, 'backed up': 0, kept: 0, skipped: 0, failed: 0 };
  for (const row of rows) totals[row.action] += 1;
  return { root, folder, base, dry_run: dryRun, rows, totals };
}

function formatTidy(result) {
  const lines = [];
  const would = result.dry_run;
  const verb = {
    removed: would ? 'would remove' : 'removed',
    'backed up': would ? 'would back up and remove' : 'backed up and removed',
    kept: 'kept',
    skipped: 'skipped',
    failed: 'failed',
  };
  for (const row of result.rows) lines.push(`${verb[row.action]} ${row.name}: ${row.reason}`);
  const t = result.totals;
  const parts = [
    `${t.removed} ${would ? 'to remove' : 'removed'}`,
    `${t['backed up']} ${would ? 'to back up' : 'backed up'}`,
    `${t.kept} kept`,
    `${t.skipped} skipped`,
  ];
  if (t.failed) parts.push(`${t.failed} failed`);
  lines.push(`total: ${t.copies} member ${t.copies === 1 ? 'copy' : 'copies'}, ${parts.join(', ')}`);
  return lines.join('\n');
}

function memberTidyCommand(...args) {
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;
  const result = tidyMemberCopies(process.cwd(), {
    dryRun: args.includes('--dry-run'),
    noFetch: args.includes('--no-fetch'),
    days: Number.isFinite(days) ? days : undefined,
  });
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
    return result;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTidy(result));
  }
  if (result.totals.failed) process.exitCode = 1;
  return result;
}

module.exports = { tidyMemberCopies, formatTidy, memberTidyCommand, worktreesFolder };

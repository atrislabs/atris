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

function defaultBranch(root) {
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (head.ok && head.out) return head.out;
  for (const name of ['origin/master', 'origin/main']) {
    if (git(['rev-parse', '--verify', '--quiet', name], root).ok) return name;
  }
  return null;
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
function processCwds() {
  const res = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 });
  const rows = [];
  let pid = null;
  for (const line of String(res.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) rows.push({ pid, cwd: line.slice(1) });
  }
  return rows;
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

function changedFiles(copyPath) {
  const res = git(['status', '--porcelain'], copyPath);
  if (!res.ok) return null;
  return res.raw.split('\n').filter(Boolean).map((line) => line.slice(3));
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
  const realFolder = realish(folder);

  if (!options.noFetch) git(['fetch', '--quiet', 'origin'], root);
  const base = defaultBranch(root);
  if (!base) return { error: 'Could not find the main branch on origin, so nothing is safe to remove.' };

  const copies = listWorktrees(root).filter((wt) => isInside(realFolder, realish(wt.path)));
  const cwds = copies.length ? processCwds() : [];
  const rows = [];

  for (const wt of copies) {
    const name = path.basename(wt.path);
    const row = { name, path: wt.path, branch: wt.branch };
    rows.push(row);

    // Hard guard: only paths inside the worktrees folder are ever touched.
    if (!isInside(realFolder, realish(wt.path))) {
      Object.assign(row, { action: 'skipped', reason: 'outside the member copies folder' });
      continue;
    }
    if (!fs.existsSync(wt.path)) {
      Object.assign(row, { action: 'skipped', reason: 'folder is already gone, run git worktree prune' });
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

    const merged = git(['merge-base', '--is-ancestor', 'HEAD', base], wt.path).ok;
    const days = ageDays(wt.path, now);
    row.days = days;

    if (merged) {
      row.action = 'removed';
      row.reason = `merged into ${base.replace(/^origin\//, '')}`;
      if (dryRun) continue;
      const removed = git(['worktree', 'remove', wt.path], root);
      if (!removed.ok) {
        Object.assign(row, { action: 'failed', reason: `git would not remove it: ${removed.err.split('\n')[0]}` });
        continue;
      }
      if (wt.branch) {
        const del = git(['branch', '-D', wt.branch], root);
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
    const pushed = git(['push', '--quiet', 'origin', `refs/heads/${wt.branch}:refs/heads/${backup}`], root);
    if (!pushed.ok) {
      Object.assign(row, { action: 'failed', reason: `backup push failed, copy kept: ${pushed.err.split('\n')[0]}` });
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

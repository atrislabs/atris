'use strict';

// Bring a repo to zen state. Every step is recoverable: stashes become refs
// under refs/archive/, stray code and unpushed commits go to zen-backup/
// branches, side copies are removed only when clean (their branches stay),
// and only merged branches are deleted. Anything touched recently is left
// alone, because someone may be working on it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runGit } = require('./checkout-sync');
const {
  checkZen,
  defaultBranch,
  dirtyEntries,
  gitOut,
  isTeamState,
  listWorktrees,
  readTeamState,
} = require('./zen');
const { workspaceZen } = require('./zen-workspace');

const FRESH_MINUTES = 30;
const ABANDONED_DAYS = 3;

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0] || 'git refused';
}

function chunks(list, size = 200) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function gitEnv(args, cwd, env) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
}

function commonDir(root) {
  const dir = gitOut(['rev-parse', '--git-common-dir'], root);
  return path.resolve(root, dir || '.git');
}

function mtime(file) {
  try {
    return fs.lstatSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// A checkout whose HEAD moved recently is in use: someone just committed,
// switched, or created it.
function headMovedSince(checkout, cutoff) {
  const gitDir = gitOut(['rev-parse', '--git-dir'], checkout);
  if (!gitDir) return false;
  const dir = path.resolve(checkout, gitDir);
  return Math.max(mtime(path.join(dir, 'logs', 'HEAD')), mtime(path.join(dir, 'HEAD'))) > cutoff;
}

function untrackedFiles(root, dir) {
  const out = gitOut(['ls-files', '--others', '--exclude-standard', '-z', '--', dir], root);
  return out ? out.split('\0').filter(Boolean) : [];
}

function identityEnv(root) {
  const env = {};
  if (!gitOut(['config', 'user.name'], root)) {
    env.GIT_AUTHOR_NAME = 'atris zen';
    env.GIT_COMMITTER_NAME = 'atris zen';
  }
  if (!gitOut(['config', 'user.email'], root)) {
    env.GIT_AUTHOR_EMAIL = 'zen@atris.local';
    env.GIT_COMMITTER_EMAIL = 'zen@atris.local';
  }
  return env;
}

function archiveStashes(root, tag) {
  const shas = (gitOut(['stash', 'list', '--format=%H'], root) || '').split('\n').filter(Boolean);
  if (!shas.length) return null;
  const prefix = `refs/archive/zen-${tag}`;
  shas.forEach((sha, i) => {
    runGit(['update-ref', `${prefix}/stash-${String(i).padStart(3, '0')}`, sha], root);
  });
  const archived = (gitOut(['for-each-ref', '--format=%(objectname)', prefix], root) || '')
    .split('\n').filter(Boolean).length;
  if (archived !== shas.length || runGit(['stash', 'clear'], root).status !== 0) {
    return { left: 'could not archive the old stashes, so they stay where they are' };
  }
  return { done: `saved ${plural(shas.length, 'old stash', 'old stashes')} away`, saved: prefix };
}

// When the newest unsaved change in a side copy was made.
function lastTouched(checkout) {
  let newest = 0;
  for (const entry of dirtyEntries(checkout)) {
    const paths = entry.xy === '??' && entry.path.endsWith('/')
      ? untrackedFiles(checkout, entry.path)
      : [entry.path];
    for (const p of paths) newest = Math.max(newest, mtime(path.join(checkout, p)));
  }
  return newest;
}

// Save every unsaved change in a side copy onto a branch. Returns the branch
// only when the branch provably holds all of it.
function saveSideCopy(root, checkout, tag) {
  const index = path.join(os.tmpdir(), `atris-zen-side-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index, ...identityEnv(checkout) };
  try {
    if (gitEnv(['read-tree', 'HEAD'], checkout, env).status !== 0) return null;
    if (gitEnv(['add', '-A', '.'], checkout, env).status !== 0) return null;
    const unsaved = gitEnv(['ls-files', '--others', '--exclude-standard'], checkout, env).stdout.trim();
    if (unsaved || gitEnv(['diff-files', '--quiet'], checkout, env).status !== 0) return null;
    const tree = gitEnv(['write-tree'], checkout, env).stdout.trim();
    const name = path.basename(checkout).replace(/[^A-Za-z0-9._-]/g, '-');
    const commit = gitEnv(['commit-tree', tree, '-p', 'HEAD', '-m', `atris zen: unsaved work from ${name}`], checkout, env)
      .stdout.trim();
    const branch = `zen-backup/${tag}-${name}`;
    if (!commit || runGit(['update-ref', `refs/heads/${branch}`, commit], root).status !== 0) return null;
    return branch;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function putAwaySideCopies(root, cutoff, staleCutoff, tag) {
  let removed = 0;
  let busy = 0;
  let inUse = 0;
  let prune = false;
  const kept = [];
  for (const wt of listWorktrees(root)) {
    if (path.resolve(wt.path) === path.resolve(root)) continue;
    if (wt.prunable || !fs.existsSync(wt.path)) {
      prune = true;
      removed += 1;
      continue;
    }
    if (headMovedSince(wt.path, cutoff)) {
      inUse += 1;
      continue;
    }
    const status = runGit(['status', '--porcelain'], wt.path);
    if (status.status !== 0) {
      busy += 1;
      continue;
    }
    if (status.stdout.trim()) {
      // Unsaved work nobody has touched in days goes to a branch, then away.
      const abandoned = !headMovedSince(wt.path, staleCutoff) && lastTouched(wt.path) <= staleCutoff;
      const branch = abandoned ? saveSideCopy(root, wt.path, tag) : null;
      if (branch && runGit(['worktree', 'remove', '--force', wt.path], root).status === 0) kept.push(branch);
      else busy += 1;
      continue;
    }
    if (runGit(['worktree', 'remove', wt.path], root).status === 0) removed += 1;
    else busy += 1;
  }
  if (prune) runGit(['worktree', 'prune'], root);
  return { removed, busy, inUse, kept };
}

function clearMergedBranches(root, upstream, main) {
  const checkedOut = new Set(listWorktrees(root).map((wt) => wt.branch).filter(Boolean));
  const current = gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const merged = (gitOut(['branch', '--merged', upstream, '--format=%(refname:short)'], root) || '')
    .split('\n')
    .filter((name) => name && name !== main && name !== current && !checkedOut.has(name));
  let cleared = 0;
  for (const name of merged) {
    if (runGit(['branch', '-q', '-d', name], root).status === 0) cleared += 1;
  }
  return cleared;
}

// Save stray code edits on a zen-backup branch, then return those files to
// HEAD. Edits from the last few minutes are left alone.
function saveStrayEdits(root, teamState, tag, cutoff) {
  const fresh = new Set();
  const files = new Set();
  for (const entry of dirtyEntries(root)) {
    if (isTeamState(entry.path, teamState)) continue;
    const paths = entry.xy === '??' && entry.path.endsWith('/')
      ? untrackedFiles(root, entry.path)
      : [entry.path, entry.orig].filter(Boolean);
    const isFresh = paths.some((p) => mtime(path.join(root, p)) > cutoff);
    for (const p of paths) (isFresh ? fresh : files).add(p);
  }
  const result = { saved: 0, fresh: fresh.size, branch: null, left: null };
  const list = [...files];
  if (!list.length) return result;
  if (runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root).status !== 0) {
    result.left = 'stray edits stay, because this repo has no commits yet';
    return result;
  }

  const index = path.join(os.tmpdir(), `atris-zen-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index, ...identityEnv(root) };
  try {
    gitEnv(['read-tree', 'HEAD'], root, env);
    for (const part of chunks(list)) gitEnv(['add', '-A', '--', ...part], root, env);
    const tree = gitEnv(['write-tree'], root, env).stdout.trim();
    const commit = gitEnv(['commit-tree', tree, '-p', 'HEAD', '-m', `atris zen: stray edits saved ${tag}`], root, env)
      .stdout.trim();
    const branch = `zen-backup/${tag}`;
    if (!commit || runGit(['update-ref', `refs/heads/${branch}`, commit], root).status !== 0) {
      result.left = 'could not save the stray edits, so they stay in the tree';
      return result;
    }

    // Only touch files the backup really holds.
    const held = new Set();
    for (const part of chunks(list)) {
      (gitOut(['ls-tree', '-r', '--name-only', commit, '--', ...part], root) || '')
        .split('\n').filter(Boolean).forEach((p) => held.add(p));
    }
    const inHead = new Set();
    for (const part of chunks(list)) {
      (gitOut(['ls-tree', '-r', '--name-only', 'HEAD', '--', ...part], root) || '')
        .split('\n').filter(Boolean).forEach((p) => inHead.add(p));
    }
    const restore = list.filter((p) => inHead.has(p));
    const remove = list.filter((p) => !inHead.has(p) && held.has(p));
    for (const part of chunks(restore)) runGit(['checkout', '-q', 'HEAD', '--', ...part], root);
    for (const part of chunks(remove)) runGit(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...part], root);
    for (const p of remove) {
      fs.rmSync(path.join(root, p), { force: true });
      let dir = path.dirname(path.join(root, p));
      while (dir.startsWith(root) && dir !== root) {
        try {
          fs.rmdirSync(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    result.saved = restore.length + remove.length;
    result.branch = branch;
    return result;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// Run a fast-forward or reset. If uncommitted team notes are in the way, save
// them, move, then lay them back on top.
function moveKeepingNotes(root, args, target, tag) {
  const first = runGit(args, root);
  if (first.status === 0) return { ok: true, notes: [] };

  const changed = new Set((gitOut(['diff', '--name-only', 'HEAD', target], root) || '').split('\n').filter(Boolean));
  const dirty = dirtyEntries(root);
  const tracked = dirty.filter((e) => e.xy !== '??' && changed.has(e.path)).map((e) => e.path);
  const untracked = dirty
    .filter((e) => e.xy === '??')
    .flatMap((e) => (e.path.endsWith('/') ? untrackedFiles(root, e.path) : [e.path]))
    .filter((p) => changed.has(p));
  if (!tracked.length && !untracked.length) return { ok: false, error: firstLine(first.stderr) };

  const dir = path.join(commonDir(root), 'atris-zen', tag);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, 'team-notes.patch');
  if (tracked.length) {
    const diff = runGit(['diff', '--binary', 'HEAD', '--', ...tracked], root);
    fs.writeFileSync(patchFile, diff.stdout);
    runGit(['checkout', '-q', 'HEAD', '--', ...tracked], root);
  }
  for (const p of untracked) {
    const dest = path.join(dir, 'untracked', p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, p), dest);
    fs.rmSync(path.join(root, p), { force: true });
  }

  const second = runGit(args, root);
  const notes = [];
  if (tracked.length) {
    const applied = runGit(['apply', '-3', '--binary', patchFile], root);
    runGit(['reset', '-q', '--', ...tracked], root);
    if (applied.status !== 0) notes.push(`some team notes clashed with new changes; your versions are in ${patchFile}`);
  }
  for (const p of untracked) {
    const saved = path.join(dir, 'untracked', p);
    if (fs.existsSync(path.join(root, p))) {
      notes.push(`kept the new ${p}; your copy is in ${saved}`);
    } else {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.copyFileSync(saved, path.join(root, p));
    }
  }
  if (second.status !== 0) return { ok: false, error: firstLine(second.stderr), notes };
  return { ok: true, notes };
}

// Unpushed commits can carry team-note edits. Their commits move to a backup
// branch, but the notes stay in the tree, uncommitted, like any team note.
function carryTeamNotes(root, base, commit, teamState, tag) {
  const files = (gitOut(['diff', '--name-only', base, commit], root) || '')
    .split('\n').filter((p) => p && isTeamState(p, teamState));
  if (!files.length) return { carried: 0, notes: [] };
  const diff = runGit(['diff', '--binary', base, commit, '--', ...files], root);
  if (diff.status !== 0 || !diff.stdout) return { carried: 0, notes: [] };
  const dir = path.join(commonDir(root), 'atris-zen', tag);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, 'unpushed-team-notes.patch');
  fs.writeFileSync(patchFile, diff.stdout);
  const applied = runGit(['apply', '-3', '--binary', patchFile], root);
  runGit(['reset', '-q', '--', ...files], root);
  if (applied.status !== 0) {
    return { carried: 0, notes: [`team notes from the unpushed commits clashed; they are in ${patchFile}`] };
  }
  return { carried: files.length, notes: [] };
}

function applyZen({ cwd = process.cwd(), fetch = true, freshMinutes, abandonedDays, now = new Date() } = {}) {
  const minutes = Number.isFinite(freshMinutes)
    ? freshMinutes
    : Number.parseFloat(process.env.ATRIS_ZEN_FRESH_MINUTES || FRESH_MINUTES);
  const staleDays = Number.isFinite(abandonedDays)
    ? abandonedDays
    : Number.parseFloat(process.env.ATRIS_ZEN_ABANDONED_DAYS || ABANDONED_DAYS);
  const before = checkZen({ cwd, fetch });
  if (!before.ok) return before;

  const root = before.root;
  const tag = stamp(now);
  const cutoff = now.getTime() - minutes * 60000;
  const window = `the last ${plural(minutes, 'minute', 'minutes')}`;
  const done = [];
  const left = [];
  const saved = [];
  const notes = [];
  const teamState = readTeamState(root);
  const main = before.upstream ? defaultBranch(root, 'origin') : null;
  const homeInUse = headMovedSince(root, cutoff);

  const stashes = archiveStashes(root, tag);
  if (stashes?.done) {
    done.push(stashes.done);
    saved.push(stashes.saved);
  } else if (stashes?.left) {
    left.push(stashes.left);
  }

  const copies = putAwaySideCopies(root, cutoff, now.getTime() - staleDays * 86400000, tag);
  if (copies.removed) done.push(`put away ${plural(copies.removed, 'idle side copy', 'idle side copies')}`);
  if (copies.kept.length) {
    done.push(`saved ${plural(copies.kept.length, 'side copy', 'side copies')} untouched for ${plural(staleDays, 'day', 'days')} to zen-backup/ and put ${copies.kept.length === 1 ? 'it' : 'them'} away`);
    saved.push(...copies.kept.map((b) => `refs/heads/${b}`));
  }
  if (copies.busy) left.push(`${plural(copies.busy, 'side copy has', 'side copies have')} unsaved work, left for ${copies.busy === 1 ? 'its owner' : 'their owners'}`);
  if (copies.inUse) left.push(`${plural(copies.inUse, 'side copy was', 'side copies were')} used in ${window}`);

  const stray = saveStrayEdits(root, teamState, tag, cutoff);
  if (stray.saved) {
    done.push(`saved ${plural(stray.saved, 'stray edit', 'stray edits')} to ${stray.branch}`);
    saved.push(`refs/heads/${stray.branch}`);
  }
  if (stray.fresh) left.push(`${plural(stray.fresh, 'edit was', 'edits were')} made in ${window}, so ${stray.fresh === 1 ? 'it stays' : 'they stay'}`);
  if (stray.left) left.push(stray.left);

  let branch = gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (main && branch !== main) {
    const stillStray = dirtyEntries(root).some((e) => !isTeamState(e.path, teamState));
    if (stillStray || homeInUse) {
      left.push(`stayed on ${branch || 'a detached commit'}, because it was used in ${window}`);
    } else {
      if (!branch) {
        const keep = `zen-backup/${tag}-detached`;
        runGit(['update-ref', `refs/heads/${keep}`, 'HEAD'], root);
        saved.push(`refs/heads/${keep}`);
      }
      const moved = moveKeepingNotes(root, ['checkout', '-q', main], main, tag);
      notes.push(...(moved.notes || []));
      if (moved.ok) {
        done.push(`moved back to ${main}${branch ? ` (${branch} is kept)` : ''}`);
        branch = main;
      } else {
        left.push(`could not move to ${main}: ${moved.error}`);
      }
    }
  }

  if (main && branch === main) {
    const counts = gitOut(['rev-list', '--left-right', '--count', `HEAD...${before.upstream}`], root) || '0 0';
    const [ahead, behind] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    if (ahead && homeInUse) {
      left.push(`${plural(ahead, 'unpushed commit stays', 'unpushed commits stay')}, made in ${window}`);
    } else if (ahead) {
      const keep = `zen-backup/${tag}-unpushed`;
      runGit(['update-ref', `refs/heads/${keep}`, 'HEAD'], root);
      const moved = moveKeepingNotes(root, ['reset', '-q', '--keep', before.upstream], before.upstream, tag);
      notes.push(...(moved.notes || []));
      if (moved.ok) {
        done.push(`moved ${plural(ahead, 'unpushed commit', 'unpushed commits')} to ${keep}`);
        const base = gitOut(['merge-base', keep, before.upstream], root);
        const carried = base ? carryTeamNotes(root, base, keep, teamState, tag) : { carried: 0, notes: [] };
        notes.push(...carried.notes);
        if (carried.carried) {
          done.push(`kept ${plural(carried.carried, 'team note', 'team notes')} from ${ahead === 1 ? 'it' : 'them'} in the tree`);
        }
        if (behind) done.push(`caught up ${plural(behind, 'commit', 'commits')} from ${before.upstream}`);
        saved.push(`refs/heads/${keep}`);
      } else {
        runGit(['update-ref', '-d', `refs/heads/${keep}`], root);
        left.push(`could not line up with ${before.upstream}: ${moved.error}`);
      }
    } else if (behind) {
      const moved = moveKeepingNotes(root, ['merge', '-q', '--ff-only', before.upstream], before.upstream, tag);
      notes.push(...(moved.notes || []));
      if (moved.ok) done.push(`caught up ${plural(behind, 'commit', 'commits')} from ${before.upstream}`);
      else left.push(`could not catch up with ${before.upstream}: ${moved.error}`);
    }
  }

  if (before.upstream) {
    const cleared = clearMergedBranches(root, before.upstream, main);
    if (cleared) done.push(`cleared ${plural(cleared, 'finished branch', 'finished branches')}`);
  }

  const workspace = workspaceZen({ root });

  const after = checkZen({ cwd: root, fetch: false });
  const result = {
    ok: true,
    zen: after.zen,
    root,
    upstream: before.upstream,
    already: before.zen && !workspace.done.length,
    workspace,
    done,
    left,
    notes,
    saved,
    team_files: after.team_files,
    remaining: after.problems.map((p) => p.text),
  };
  try {
    fs.appendFileSync(path.join(commonDir(root), 'atris-zen.jsonl'), `${JSON.stringify({
      at: now.toISOString(),
      before: before.problems.map((p) => ({ kind: p.kind, count: p.count || 1 })),
      after: after.problems.map((p) => ({ kind: p.kind, count: p.count || 1 })),
      done,
      left,
      saved,
      workspace: workspace.done,
      yours: workspace.yours.map((item) => item.text),
    })}\n`);
  } catch {
    // The receipt is a nicety; zen itself already happened.
  }
  return result;
}

module.exports = { applyZen, FRESH_MINUTES, ABANDONED_DAYS };

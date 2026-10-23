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
  branchMovedSince,
  checkZen,
  defaultBranch,
  dirtyEntries,
  dirtyFiles,
  FRESH_MINUTES,
  gitOut,
  headMovedSince,
  isTeamState,
  listWorktrees,
  readTeamState,
  mtime,
  idleWithOnlyNotes,
  lastTouched,
  sideCopyLines,
  scheduledCopies,
  untrackedFiles,
  ABANDONED_DAYS,
  abandonedDaysFromEnv,
} = require('./zen');
const { workspaceZen } = require('./zen-workspace');

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

// A checkout whose HEAD moved recently is in use: someone just committed,
// switched, or created it.
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

function putAwaySideCopies(root, cutoff, staleCutoff, tag, teamState) {
  let removed = 0;
  const busy = [];
  const notesKept = [];
  let inUse = 0;
  let prune = false;
  let scheduledCount = 0;
  let locked = 0;
  const kept = [];
  const worktrees = listWorktrees(root);
  const scheduled = scheduledCopies(worktrees);
  for (const wt of worktrees) {
    if (path.resolve(wt.path) === path.resolve(root)) continue;
    if (scheduled.has(path.resolve(wt.path))) {
      scheduledCount += 1;
      continue;
    }
    if (wt.locked) {
      locked += 1;
      continue;
    }
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
      busy.push(wt.path);
      continue;
    }
    if (status.stdout.trim()) {
      // Unsaved work nobody has touched in days goes to a branch, then away.
      // So does an idle copy holding only team notes: nothing in it is work.
      const notesOnly = idleWithOnlyNotes(wt.path, teamState, cutoff);
      const abandoned = !headMovedSince(wt.path, staleCutoff) && lastTouched(wt.path) <= staleCutoff;
      const branch = notesOnly || abandoned ? saveSideCopy(root, wt.path, tag) : null;
      if (branch && runGit(['worktree', 'remove', '--force', wt.path], root).status === 0) {
        (notesOnly && !abandoned ? notesKept : kept).push(branch);
      } else busy.push(wt.path);
      continue;
    }
    if (runGit(['worktree', 'remove', wt.path], root).status === 0) removed += 1;
    else busy.push(wt.path);
  }
  if (prune) runGit(['worktree', 'prune'], root);
  return { removed, busy, inUse, kept, notesKept, scheduled: scheduledCount, locked };
}

function clearMergedBranches(root, upstream, main, cutoff) {
  const checkedOut = new Set(listWorktrees(root).map((wt) => wt.branch).filter(Boolean));
  const current = gitOut(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  const merged = (gitOut(['branch', '--merged', upstream, '--format=%(refname:short)'], root) || '')
    .split('\n')
    .filter((name) => name && name !== main && name !== current && !checkedOut.has(name))
    .filter((name) => !branchMovedSince(root, name, cutoff));
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
      ? untrackedFiles(root, entry.path).filter((p) => !isTeamState(p, teamState))
      : [entry.path, entry.orig].filter(Boolean);
    if (!paths.length) continue;
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

// Files a 3-way apply left with conflict marks. Each goes back to the new
// version, so a team note never holds <<<<<<< lines.
function settleClashes(root, files) {
  const clashed = (gitOut(['diff', '--name-only', '--diff-filter=U', '--', ...files], root) || '')
    .split('\n').filter(Boolean);
  runGit(['reset', '-q', '--', ...files], root);
  for (const p of clashed) runGit(['checkout', '-q', 'HEAD', '--', p], root);
  return clashed;
}

// Lay a saved patch of team notes back down. One file that cannot go back
// (say its note was deleted upstream) makes git refuse the whole patch, so on
// that refusal each file goes back on its own and only the misfits stay out.
function applyNotes(root, patchFile, files) {
  const whole = runGit(['apply', '-3', '--binary', patchFile], root);
  const clashed = settleClashes(root, files);
  if (whole.status === 0 || clashed.length) return { clashed, missed: [] };
  const missed = [];
  for (const p of files) {
    const one = runGit(['apply', '-3', '--binary', `--include=${p.replace(/[*?[\\]/g, '\\$&')}`, patchFile], root);
    if (settleClashes(root, [p]).length) clashed.push(p);
    else if (one.status !== 0) missed.push(p);
  }
  return { clashed, missed };
}

function sameBytes(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// A live journal only grows, so two versions of one day's log hold no real
// conflict: keep the incoming log and add each line of yours it lacks, in
// your order. Archived journals are finished and keep the usual handling.
function isJournal(p) {
  return /(^|\/)logs\/.+\.md$/.test(p) && !/(^|\/)archive\//.test(p);
}

function joinJournal(file, mine) {
  let incoming;
  let yours;
  try {
    incoming = fs.readFileSync(file, 'utf8');
    yours = fs.readFileSync(mine, 'utf8');
  } catch {
    return false;
  }
  const have = new Set(incoming.split('\n').map((line) => line.trim()).filter(Boolean));
  const extra = yours.split('\n').filter((line) => line.trim() && !have.has(line.trim()));
  if (extra.length) fs.writeFileSync(file, `${incoming.replace(/\n*$/, '\n')}\n${extra.join('\n')}\n`);
  return true;
}

// Notes moved to a new path between two commits, old path to new.
function movedNotes(root, from, to) {
  const out = runGit(['diff', '--name-status', '-z', '-M', from, to], root).stdout || '';
  const parts = out.split('\0');
  const moves = new Map();
  for (let i = 0; i < parts.length; i += 1) {
    if (/^[RC]\d*$/.test(parts[i])) {
      if (parts[i][0] === 'R') moves.set(parts[i + 1], parts[i + 2]);
      i += 2;
    } else if (parts[i]) {
      i += 1;
    }
  }
  return moves;
}

// Carry your edits to a note onto the path it moved to, with a 3-way merge
// against the version you started from. Only a clean merge is written.
function followMove(root, fromCommit, from, to, mine) {
  const dest = path.join(root, to);
  const base = runGit(['show', `${fromCommit}:${from}`], root);
  if (base.status !== 0 || !fs.existsSync(mine) || !fs.existsSync(dest)) return false;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-move-'));
  try {
    fs.writeFileSync(path.join(work, 'base'), base.stdout);
    const merged = spawnSync('git', ['merge-file', '-p', dest, path.join(work, 'base'), mine], { encoding: 'utf8' });
    if (merged.status !== 0) return false;
    fs.writeFileSync(dest, merged.stdout);
    return true;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Run a fast-forward or reset. If uncommitted team notes are in the way, save
// them, move, then lay them back on top. `from` is where the saved changes
// start: dropping unpushed commits or leaving a side branch passes the base,
// so a note committed there and edited again since comes back whole, not
// just the later edit.
function moveKeepingNotes(root, args, target, tag, from = 'HEAD') {
  const first = runGit(args, root);
  if (first.status === 0) return { ok: true, notes: [], tracked: [], landed: [] };

  // Without rename detection a note moved upstream shows up under its old
  // path too, so an edit to it is saved instead of blocking the move.
  const changed = new Set((gitOut(['diff', '--name-only', '--no-renames', 'HEAD', target], root) || '').split('\n').filter(Boolean));
  const moves = movedNotes(root, 'HEAD', target);
  const fromCommit = gitOut(['rev-parse', '--verify', '--quiet', `${from}^{commit}`], root);
  const dirty = dirtyEntries(root);
  // A new note that was only staged has nothing in HEAD to go back to, so it
  // is unstaged and handled like any untracked note.
  const added = dirty.filter((e) => e.xy[0] === 'A' && changed.has(e.path)).map((e) => e.path);
  if (added.length) runGit(['reset', '-q', '--', ...added], root);
  const tracked = dirty.filter((e) => e.xy !== '??' && e.xy[0] !== 'A' && changed.has(e.path)).map((e) => e.path);
  const untracked = dirty
    .filter((e) => e.xy === '??')
    .flatMap((e) => (e.path.endsWith('/') ? untrackedFiles(root, e.path) : [e.path]))
    .filter((p) => changed.has(p))
    .concat(added);
  // A note you moved with git mv whose old path changed upstream: the old
  // path goes back to HEAD so the move can run, and the new edits are merged
  // into your moved copy afterwards.
  const renamed = dirty.filter((e) => e.xy[0] === 'R' && e.orig && changed.has(e.orig) && !changed.has(e.path));
  for (const e of renamed) {
    runGit(['reset', '-q', '--', e.orig, e.path], root);
    runGit(['checkout', '-q', 'HEAD', '--', e.orig], root);
  }
  if (!tracked.length && !untracked.length && !renamed.length) return { ok: false, error: firstLine(first.stderr) };

  const dir = path.join(commonDir(root), 'atris-zen', tag);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, 'team-notes.patch');
  if (tracked.length) {
    const diff = runGit(['diff', '--binary', from, '--', ...tracked], root);
    fs.writeFileSync(patchFile, diff.stdout);
    for (const p of tracked) {
      if (!fs.existsSync(path.join(root, p))) continue;
      const mine = path.join(dir, 'mine', p);
      fs.mkdirSync(path.dirname(mine), { recursive: true });
      fs.copyFileSync(path.join(root, p), mine);
    }
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
  let landed = [];
  if (tracked.length) {
    const { clashed, missed } = applyNotes(root, patchFile, tracked);
    landed = tracked.filter((p) => !clashed.includes(p) && !missed.includes(p));
    for (const p of clashed) {
      const mine = path.join(dir, 'mine', p);
      if (isJournal(p) && joinJournal(path.join(root, p), mine)) notes.push(`joined your ${p} onto the new one`);
      else notes.push(`kept the new ${p}; your copy is in ${mine}`);
    }
    for (const p of missed) {
      const mine = path.join(dir, 'mine', p);
      const to = moves.get(p);
      if (to && fromCommit && followMove(root, fromCommit, p, to, mine)) {
        notes.push(`${p} moved to ${to}, and your edits went with it`);
      } else if (to) {
        notes.push(`${p} moved to ${to} and your edits clash there; your copy is in ${fs.existsSync(mine) ? mine : patchFile}`);
      } else {
        notes.push(`${p} no longer fits the new changes; your copy is in ${fs.existsSync(mine) ? mine : patchFile}`);
      }
    }
  }
  for (const p of untracked) {
    const saved = path.join(dir, 'untracked', p);
    if (fs.existsSync(path.join(root, p))) {
      // A copy that matches the incoming file loses nothing, so say nothing.
      if (sameBytes(saved, path.join(root, p))) fs.rmSync(saved, { force: true });
      else if (isJournal(p) && joinJournal(path.join(root, p), saved)) notes.push(`joined your ${p} onto the new one`);
      else notes.push(`kept the new ${p}; your copy is in ${saved}`);
    } else {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.copyFileSync(saved, path.join(root, p));
    }
  }
  for (const e of renamed) {
    const old = path.join(root, e.orig);
    if (second.status !== 0 || !fs.existsSync(old)) continue;
    if (fromCommit && followMove(root, fromCommit, e.orig, e.path, old)) {
      fs.rmSync(old, { force: true });
      notes.push(`${e.orig} changed upstream after you moved it to ${e.path}; the new edits went with it`);
    } else {
      notes.push(`${e.orig} changed upstream after you moved it to ${e.path}; the new version is back at ${e.orig}`);
    }
  }
  if (second.status !== 0) return { ok: false, error: firstLine(second.stderr), notes, tracked, landed };
  return { ok: true, notes, tracked, landed };
}

// Unpushed commits can carry team-note edits. Their commits move to a backup
// branch, but the notes stay in the tree, uncommitted, like any team note.
// A note that was also edited since came back with the move already, commit
// and all, so it is counted and not laid down twice.
function carryTeamNotes(root, base, commit, teamState, tag, moved = { tracked: [], landed: [] }) {
  const touched = (gitOut(['diff', '--name-only', base, commit], root) || '')
    .split('\n').filter((p) => p && isTeamState(p, teamState));
  const already = touched.filter((p) => moved.landed.includes(p)).length;
  const files = touched.filter((p) => !moved.tracked.includes(p));
  if (!files.length) return { carried: already, notes: [] };
  const diff = runGit(['diff', '--binary', base, commit, '--', ...files], root);
  if (diff.status !== 0 || !diff.stdout) return { carried: already, notes: [] };
  const dir = path.join(commonDir(root), 'atris-zen', tag);
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, 'unpushed-team-notes.patch');
  fs.writeFileSync(patchFile, diff.stdout);
  const { clashed, missed } = applyNotes(root, patchFile, files);
  const notes = clashed.map((p) => `kept the new ${p}; yours is on ${commit}`);
  // A note moved upstream takes the commit's edits to its new path.
  const moves = missed.length ? movedNotes(root, base, 'HEAD') : new Map();
  let followed = 0;
  for (const p of missed) {
    const to = moves.get(p);
    const theirs = to ? runGit(['show', `${commit}:${p}`], root) : null;
    const mine = path.join(dir, 'unpushed', p);
    if (theirs?.status === 0) {
      fs.mkdirSync(path.dirname(mine), { recursive: true });
      fs.writeFileSync(mine, theirs.stdout);
    }
    if (theirs?.status === 0 && followMove(root, base, p, to, mine)) {
      notes.push(`${p} moved to ${to}, and the edits from ${commit} went with it`);
      followed += 1;
    } else if (to) {
      notes.push(`${p} moved to ${to} and the edits clash there; yours is on ${commit}`);
    } else {
      notes.push(`${p} no longer fits the new changes; yours is on ${commit}`);
    }
  }
  return { carried: already + followed + files.length - clashed.length - missed.length, notes };
}

function applyZen({ cwd = process.cwd(), fetch = true, freshMinutes, abandonedDays, now = new Date() } = {}) {
  const minutes = Number.isFinite(freshMinutes)
    ? freshMinutes
    : Number.parseFloat(process.env.ATRIS_ZEN_FRESH_MINUTES || FRESH_MINUTES);
  const staleDays = Number.isFinite(abandonedDays) ? abandonedDays : abandonedDaysFromEnv();
  const before = checkZen({ cwd, fetch, freshMinutes: minutes, now: now.getTime() });
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

  const copies = putAwaySideCopies(root, cutoff, now.getTime() - staleDays * 86400000, tag, teamState);
  if (copies.removed) done.push(`put away ${plural(copies.removed, 'idle side copy', 'idle side copies')}`);
  if (copies.notesKept.length) {
    const n = copies.notesKept.length;
    done.push(`saved the team notes from ${plural(n, 'idle side copy', 'idle side copies')} to zen-backup/ and put ${n === 1 ? 'it' : 'them'} away`);
    saved.push(...copies.notesKept.map((b) => `refs/heads/${b}`));
  }
  if (copies.kept.length) {
    done.push(`saved ${plural(copies.kept.length, 'side copy', 'side copies')} untouched for ${plural(staleDays, 'day', 'days')} to zen-backup/ and put ${copies.kept.length === 1 ? 'it' : 'them'} away`);
    saved.push(...copies.kept.map((b) => `refs/heads/${b}`));
  }
  if (copies.busy.length) left.push(...sideCopyLines(copies.busy, staleDays));
  if (copies.scheduled) left.push(`${plural(copies.scheduled, 'side copy is', 'side copies are')} used by a scheduled job, so ${copies.scheduled === 1 ? 'it stays' : 'they stay'}`);
  if (copies.locked) left.push(`${plural(copies.locked, 'side copy is', 'side copies are')} locked by ${copies.locked === 1 ? 'its owner, so it stays' : 'their owners, so they stay'}`);
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
    const stillStray = dirtyFiles(root).some((p) => !isTeamState(p, teamState));
    if (stillStray || homeInUse) {
      left.push(`stayed on ${branch || 'a detached commit'}, because it was used in ${window}`);
    } else {
      if (!branch) {
        const keep = `zen-backup/${tag}-detached`;
        runGit(['update-ref', `refs/heads/${keep}`, 'HEAD'], root);
        saved.push(`refs/heads/${keep}`);
      }
      // Saved from where the branch left main, so a note committed on the
      // branch and edited again since comes back whole.
      const base = gitOut(['merge-base', 'HEAD', main], root);
      const moved = moveKeepingNotes(root, ['checkout', '-q', main], main, tag, base || 'HEAD');
      notes.push(...(moved.notes || []));
      // A branch with nothing beyond origin is cleared as finished below, so
      // only a branch with its own commits is called kept.
      const own = branch && before.upstream ? gitOut(['rev-list', '--count', `${before.upstream}..${branch}`], root) : null;
      if (moved.ok) {
        const why = !branch ? '' : own === '0' ? ` (${branch} had nothing new)` : ` (${branch} is kept)`;
        done.push(`moved back to ${main}${why}`);
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
      const base = gitOut(['merge-base', keep, before.upstream], root);
      const moved = moveKeepingNotes(root, ['reset', '-q', '--keep', before.upstream], before.upstream, tag, base || 'HEAD');
      notes.push(...(moved.notes || []));
      if (moved.ok) {
        done.push(`moved ${plural(ahead, 'unpushed commit', 'unpushed commits')} to ${keep}`);
        const carried = base ? carryTeamNotes(root, base, keep, teamState, tag, moved) : { carried: 0, notes: [] };
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
    const cleared = clearMergedBranches(root, before.upstream, main, now.getTime() - minutes * 60000);
    if (cleared) done.push(`cleared ${plural(cleared, 'finished branch', 'finished branches')}`);
  }

  const workspace = workspaceZen({ root });

  const after = checkZen({ cwd: root, fetch: false, freshMinutes: minutes, now: now.getTime() });
  const result = {
    ok: true,
    zen: after.zen,
    root,
    upstream: before.upstream,
    already: before.zen && !done.length && !workspace.done.length,
    workspace,
    done,
    left,
    notes,
    saved,
    team_files: after.team_files,
    team_places: after.team_places,
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

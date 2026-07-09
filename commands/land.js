const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { listWorktrees, statusCounts } = require('./worktree');

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_STALE_HOURS = 48;
const WORKTREE_REAP_GRACE_MS = 60 * 60 * 1000;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function runGit(args, { cwd = process.cwd(), check = true, maxBuffer } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...(maxBuffer ? { maxBuffer } : {}) });
  if (check && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function repoRoot(cwd = process.cwd()) {
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd, check: false });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function refExists(root, ref) {
  return runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: root, check: false }).status === 0;
}

function baseBranch(root, override = '') {
  if (override && refExists(root, override)) return override;
  if (refExists(root, 'origin/master')) return 'origin/master';
  if (refExists(root, 'origin/main')) return 'origin/main';
  if (refExists(root, 'master')) return 'master';
  if (refExists(root, 'main')) return 'main';
  return '';
}

function ageDays(unixSeconds, now = Date.now()) {
  return Math.floor((now / 1000 - Number(unixSeconds)) / 86400);
}

function ageHours(unixSeconds, now = Date.now()) {
  return Math.floor((now / 1000 - Number(unixSeconds)) / 3600);
}

function worktreeMtimeMs(worktreePath) {
  try {
    return fs.statSync(worktreePath).mtimeMs;
  } catch {
    return null;
  }
}

function worktreeWithinReapGrace(worktreePath, now = Date.now()) {
  const mtime = worktreeMtimeMs(worktreePath);
  return typeof mtime === 'number' && now - mtime < WORKTREE_REAP_GRACE_MS;
}

function listBranches(root, base = '') {
  // With a base, ask git for ahead counts in the same single spawn
  // (%(ahead-behind:) needs git >= 2.41; on failure we retry without it and
  // collectBoard falls back to per-branch aheadCount).
  const format = base
    ? `%(refname:short)%09%(committerdate:unix)%09%(ahead-behind:${base})`
    : '%(refname:short)%09%(committerdate:unix)';
  const result = runGit(['for-each-ref', 'refs/heads', `--format=${format}`], { cwd: root, check: false });
  if (result.status !== 0) {
    if (base) return listBranches(root);
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, date, aheadBehind] = line.split('\t');
      const entry = { name, lastCommitUnix: Number(date) };
      if (aheadBehind !== undefined) {
        const ahead = Number(aheadBehind.split(' ')[0]);
        if (Number.isFinite(ahead)) entry.ahead = ahead;
      }
      return entry;
    });
}

function aheadCount(root, base, ref) {
  const result = runGit(['rev-list', '--count', `${base}..${ref}`], { cwd: root, check: false });
  if (result.status !== 0) return 0;
  return Number(result.stdout.trim()) || 0;
}

function cherryStats(root, base, ref) {
  const result = runGit(['cherry', base, ref], { cwd: root, check: false });
  if (result.status !== 0) return { landedElsewhere: 0, unique: 0 };
  let landedElsewhere = 0;
  let unique = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('- ')) landedElsewhere += 1;
    else if (line.startsWith('+ ')) unique += 1;
  }
  return { landedElsewhere, unique };
}

// Board: every branch and worktree with unlanded state, classified.
//   landed — no commits ahead of base; the branch pointer is residue
//   active — has unlanded commits, younger than TTL
//   due    — has unlanded commits, older than TTL; --reap collects it
function collectBoard(root, { ttlDays = DEFAULT_TTL_DAYS, staleHours = DEFAULT_STALE_HOURS, base: baseOverride = '', now = Date.now(), light = false } = {}) {
  const base = baseBranch(root, baseOverride);
  if (!base) throw new Error('no master/main branch found');

  const branches = [];
  const lastCommitMsByBranch = new Map();
  for (const branch of listBranches(root, base)) {
    if (PROTECTED_BRANCHES.has(branch.name)) continue;
    const lastCommitMs = Number(branch.lastCommitUnix) * 1000;
    if (Number.isFinite(lastCommitMs)) lastCommitMsByBranch.set(branch.name, lastCommitMs);
    const ahead = branch.ahead !== undefined ? branch.ahead : aheadCount(root, base, branch.name);
    const age = ageDays(branch.lastCommitUnix, now);
    const hours = ageHours(branch.lastCommitUnix, now);
    const cherry = ahead > 0 ? cherryStats(root, base, branch.name) : { landedElsewhere: 0, unique: 0 };
    let state = 'active';
    if (ahead === 0 || (cherry.landedElsewhere > 0 && cherry.unique === 0)) state = 'landed';
    else if (age > ttlDays) state = 'due';
    branches.push({
      name: branch.name,
      ahead,
      ageDays: age,
      ageHours: hours,
      activityHours: hours,
      landedElsewhere: cherry.landedElsewhere,
      uniqueChanges: cherry.unique,
      stale: false,
      state,
    });
  }

  const worktrees = [];
  const all = listWorktrees(root);
  for (const wt of all.slice(1)) {
    const branch = (wt.branch || '').replace(/^refs\/heads\//, '');
    // light mode skips the full `git status` per worktree — the banner summary
    // never reads dirty counts, only worktree mtimes for staleness.
    const counts = (light ? null : statusCounts(wt.path)) || { staged: 0, unstaged: 0, untracked: 0 };
    const dirty = counts.staged + counts.unstaged + counts.untracked;
    const entry = branches.find((b) => b.name === branch) || null;
    worktrees.push({
      path: wt.path,
      branch,
      dirty,
      ageDays: entry ? entry.ageDays : null,
      ageHours: entry ? entry.ageHours : null,
      state: entry ? entry.state : 'detached',
    });
  }

  const activityByBranch = new Map(branches.map((b) => [b.name, lastCommitMsByBranch.get(b.name)]));
  for (const wt of worktrees) {
    if (!wt.branch || !activityByBranch.has(wt.branch)) continue;
    const mtime = worktreeMtimeMs(wt.path);
    if (typeof mtime === 'number' && mtime > activityByBranch.get(wt.branch)) {
      activityByBranch.set(wt.branch, mtime);
    }
  }
  for (const branch of branches) {
    const lastActivity = activityByBranch.get(branch.name);
    if (Number.isFinite(lastActivity)) {
      branch.activityHours = Math.floor((now - lastActivity) / 3600000);
    }
    branch.stale = branch.state === 'active' && branch.activityHours >= staleHours;
  }

  const due = branches.filter((b) => b.state === 'due');
  const landed = branches.filter((b) => b.state === 'landed');
  const active = branches.filter((b) => b.state === 'active');
  const stale = active.filter((b) => b.stale);
  return {
    base,
    ttlDays,
    staleHours,
    branches,
    worktrees,
    summary: {
      unlanded: branches.length,
      active: active.length,
      due: due.length,
      landed: landed.length,
      stale: stale.length,
      worktrees: worktrees.length,
    },
  };
}

// Counts for the boot banner and digest. This intentionally pays the same
// classification cost as the landing board so "in the air" never includes
// merged branch residue.
function landSummary(cwd = process.cwd(), ttlDays = DEFAULT_TTL_DAYS) {
  const root = repoRoot(cwd);
  if (!root) return null;
  const board = collectBoard(root, { ttlDays, light: true });
  return {
    branches: board.summary.active + board.summary.due,
    due: board.summary.due,
    stale: board.summary.stale,
    ttlDays,
  };
}

function salvageDir(root) {
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, '.atris', 'salvage', stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timeStamp() {
  return new Date().toISOString().slice(11, 19).replace(/:/g, '');
}

function remoteHeads(root) {
  const result = runGit(['ls-remote', '--heads', 'origin'], { cwd: root, check: false });
  if (result.status !== 0) return null;
  const heads = new Set();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const ref = line.split(/\s+/)[1] || '';
    if (ref.startsWith('refs/heads/')) heads.add(ref.slice('refs/heads/'.length));
  }
  return heads;
}

// Everything a force-remove would destroy: staged + unstaged tracked changes
// (git diff HEAD) and untracked files (copied verbatim). Returns false if any
// piece could not be saved — the caller then keeps the worktree.
function salvageWorktree(w, dir, receipt) {
  try {
    // git writes the patch file itself: routing the diff through spawnSync
    // stdout hits Node's 1MB default maxBuffer, so any worktree more than
    // ~1MB dirty read as "salvage failed" and was kept on every reap pass.
    const patchPath = path.join(dir, `${path.basename(w.path)}.dirty.patch`);
    const diff = runGit(['diff', 'HEAD', `--output=${patchPath}`], { cwd: w.path, check: false });
    if (diff.status !== 0) {
      fs.rmSync(patchPath, { force: true });
      return false;
    }
    if (fs.statSync(patchPath).size > 0) receipt.patches.push(patchPath);
    else fs.rmSync(patchPath, { force: true });
    const untracked = runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: w.path, check: false, maxBuffer: 64 * 1024 * 1024 });
    if (untracked.status !== 0) return false;
    const files = untracked.stdout.split('\0').filter(Boolean);
    if (files.length > 0) {
      const destRoot = path.join(dir, `${path.basename(w.path)}.untracked`);
      for (const rel of files) {
        const dest = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(w.path, rel), dest);
      }
      receipt.untracked.push(destRoot);
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Reap: salvage then delete everything landed (residue) or past TTL.
// Salvage first, always: unlanded commits go into a git bundle, dirty
// worktrees into patch files + untracked-file copies, so a reap is never
// a loss of work — and when a backup cannot be written, the work stays.
// includeDetached: detached-HEAD worktrees have no branch, so the salvage
// bundle cannot cover their commits — unattended reaps (autoland) pass false
// and leave them for a human reap.
function reap(root, { ttlDays = DEFAULT_TTL_DAYS, staleHours = DEFAULT_STALE_HOURS, base: baseOverride = '', dryRun = false, remote = true, includeDetached = true, protectCurrent = true, now = Date.now() } = {}) {
  const board = collectBoard(root, { ttlDays, staleHours, base: baseOverride, now });
  const targets = board.branches.filter((b) => b.state === 'landed' || b.state === 'due');
  const targetNames = new Set(targets.map((b) => b.name));
  const candidateWorktrees = board.worktrees.filter(
    (w) => targetNames.has(w.branch) || (includeDetached && w.state === 'detached') || (typeof w.ageDays === 'number' && w.ageDays > ttlDays)
  );
  const protectedWorktrees = [];
  const worktreeTargets = [];
  const current = path.resolve(root);
  for (const w of candidateWorktrees) {
    // Only the fresh-worktree grace protects here. Dirty worktrees are NOT
    // skipped: reap's salvage (bundle + patches + untracked copies below)
    // exists precisely so dirty residue can be cleared loss-free. Blanket
    // dirty protection lives in the janitor's cleanupWorktrees, which has
    // no salvage machinery.
    if (protectCurrent && path.resolve(w.path) === current) {
      protectedWorktrees.push({ ...w, reason: 'current_checkout' });
      continue;
    }
    if (worktreeWithinReapGrace(w.path, now)) {
      protectedWorktrees.push({ ...w, reason: 'fresh_worktree_grace' });
      continue;
    }
    worktreeTargets.push(w);
  }
  for (const w of protectedWorktrees) {
    if (w.branch) targetNames.delete(w.branch);
  }
  for (const w of worktreeTargets) {
    if (w.branch && !targetNames.has(w.branch)) targetNames.add(w.branch);
  }

  const receipt = {
    base: board.base,
    ttlDays,
    dryRun,
    bundle: null,
    bundleError: null,
    patches: [],
    untracked: [],
    keptWorktrees: protectedWorktrees.map((w) => `${w.path} (${w.reason})`),
    keptMovedBranches: [],
    removedWorktrees: [],
    deletedBranches: [],
    deletedRemote: [],
    kept: board.branches.filter((b) => !targetNames.has(b.name)).map((b) => b.name),
  };
  if (targetNames.size === 0 && worktreeTargets.length === 0) return receipt;
  if (dryRun) {
    receipt.removedWorktrees = worktreeTargets.map((w) => w.path);
    receipt.deletedBranches = [...targetNames];
    return receipt;
  }

  const dir = salvageDir(root);
  const withCommits = [...targetNames].filter((name) => {
    const entry = board.branches.find((b) => b.name === name);
    return entry && entry.ahead > 0;
  });
  if (withCommits.length > 0) {
    const bundlePath = path.join(dir, `reap-${timeStamp()}.bundle`);
    const result = runGit(['bundle', 'create', bundlePath, ...withCommits, '--not', board.base], {
      cwd: root,
      check: false,
    });
    if (result.status === 0) receipt.bundle = bundlePath;
    else {
      // Salvage-first is a hard promise: no bundle, no deletion of unlanded
      // work. These branches (and their worktrees) survive until a reap can
      // actually back them up.
      receipt.bundleError = String(result.stderr || result.stdout || 'bundle failed').trim().slice(0, 200);
      for (const name of withCommits) targetNames.delete(name);
    }
  }

  const survivingWorktreeTargets = worktreeTargets.filter(
    (w) => targetNames.has(w.branch) || (includeDetached && w.state === 'detached')
  );
  for (const w of survivingWorktreeTargets) {
    // Salvage-then-remove, never keep-because-dirty: patches + untracked
    // copies bank everything force-remove would destroy. The fresh-worktree
    // grace was already applied when candidates were selected.
    if (w.dirty > 0 && !salvageWorktree(w, dir, receipt)) {
      // could not fully back up what force-remove would destroy — keep it,
      // and say why: a bare path in the receipt reads as an unexplained
      // no-op (the exact silence BCK-1232 was about).
      receipt.keptWorktrees.push(`${w.path} (salvage incomplete — patch/copy failed, kept to avoid losing work)`);
      if (w.branch) targetNames.delete(w.branch);
      continue;
    }
    const removed = runGit(['worktree', 'remove', '--force', w.path], { cwd: root, check: false });
    if (removed.status === 0) {
      receipt.removedWorktrees.push(w.path);
    } else {
      // A locked worktree fails here and, unreported, reap re-salvages the
      // same patches every pass forever. Say what blocked it so a human can
      // unlock (or a dead lock can be challenged) instead of looping.
      const reason = String(removed.stderr || removed.stdout || 'remove failed').trim().slice(0, 160);
      receipt.keptWorktrees.push(`${w.path} (${reason})`);
      if (w.branch) targetNames.delete(w.branch);
    }
  }

  for (const name of targetNames) {
    const entry = board.branches.find((b) => b.name === name);
    // the board is a snapshot; an agent may have committed since it was
    // taken. A branch that moved is left alone — the next reap sees the
    // new truth and bundles it before touching it.
    if (!entry || aheadCount(root, board.base, name) !== entry.ahead) {
      receipt.keptMovedBranches.push(name);
      continue;
    }
    const deleted = runGit(['branch', '-D', name], { cwd: root, check: false });
    if (deleted.status === 0) {
      receipt.deletedBranches.push(name);
    } else {
      // Same silence class as the worktree-remove path: a branch checked
      // out in a side copy the board never saw makes -D refuse, and an
      // unreported refusal reads as "cleanup done" with nothing cleared.
      const reason = String(deleted.stderr || deleted.stdout || 'branch delete failed').trim().slice(0, 160);
      receipt.keptWorktrees.push(`branch ${name} (${reason})`);
    }
  }

  if (remote && receipt.deletedBranches.length > 0) {
    const heads = remoteHeads(root);
    if (heads) {
      const remoteTargets = receipt.deletedBranches.filter((name) => heads.has(name));
      for (let i = 0; i < remoteTargets.length; i += 25) {
        const batch = remoteTargets.slice(i, i + 25);
        const pushed = runGit(['push', 'origin', '--delete', ...batch], { cwd: root, check: false });
        if (pushed.status === 0) receipt.deletedRemote.push(...batch);
      }
    }
  }

  return receipt;
}

// The story of one piece of work: what it tried to do, whether it made it
// into master some other way, and what would be lost if it were cleared.
function collectStory(root, name, { base: baseOverride = '' } = {}) {
  const base = baseBranch(root, baseOverride);
  if (!base) throw new Error('no master/main branch found');
  if (!refExists(root, name)) return null;

  const logResult = runGit(
    ['log', '--format=%h%x09%cs%x09%an%x09%s', `${base}..${name}`],
    { cwd: root, check: false }
  );
  const changes = logResult.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, date, author, subject] = line.split('\t');
      return { hash, date, author, subject };
    });

  // git cherry marks a change '-' when an equivalent patch already exists
  // in base — the honest "it landed some other way" signal.
  const cherry = runGit(['cherry', base, name], { cwd: root, check: false });
  const landedHashes = new Set();
  for (const line of cherry.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('- ')) landedHashes.add(line.slice(2).trim());
  }
  const fullHashes = runGit(['log', '--format=%H %h', `${base}..${name}`], { cwd: root, check: false });
  const shortToLanded = new Set();
  for (const line of fullHashes.stdout.split(/\r?\n/).filter(Boolean)) {
    const [full, short] = line.split(' ');
    if (landedHashes.has(full)) shortToLanded.add(short);
  }
  for (const c of changes) c.landedElsewhere = shortToLanded.has(c.hash);

  const stat = runGit(['diff', '--stat', `${base}...${name}`], { cwd: root, check: false });
  const statLines = stat.stdout.split(/\r?\n/).filter(Boolean);
  const files = statLines.slice(0, -1).map((l) => l.split('|')[0].trim());

  const info = listBranches(root).find((b) => b.name === name);
  return {
    name,
    base,
    ageDays: info ? ageDays(info.lastCommitUnix) : null,
    changes,
    landedElsewhere: changes.filter((c) => c.landedElsewhere).length,
    uniqueChanges: changes.filter((c) => !c.landedElsewhere).length,
    files,
  };
}

function printStory(story) {
  console.log('');
  console.log(`what happened in ${story.name}`);
  console.log('');
  if (story.changes.length === 0) {
    console.log(`  everything here is already in ${story.base}. this is an empty leftover,`);
    console.log("  safe to clear. nothing would be lost.");
    console.log('');
    return;
  }
  const who = [...new Set(story.changes.map((c) => c.author))].join(', ');
  const when = story.changes[story.changes.length - 1].date;
  const last = story.changes[0].date;
  const age = story.ageDays === null ? '' : ` (${story.ageDays} days ago)`;
  console.log(`  started ${when}, last touched ${last}${age}, by ${who}.`);
  console.log('');
  console.log('  what it tried to do:');
  for (const c of [...story.changes].reverse()) {
    const mark = c.landedElsewhere ? 'made it in   ' : 'never made it';
    console.log(`    ${mark}  ${c.subject}`);
  }
  console.log('');
  if (story.files.length > 0) {
    const shown = story.files.slice(0, 6).join(', ');
    const more = story.files.length > 6 ? ` and ${story.files.length - 6} more` : '';
    console.log(`  it touched: ${shown}${more}`);
    console.log('');
  }
  if (story.uniqueChanges === 0) {
    console.log(`  bottom line: all ${story.changes.length} changes made it into ${story.base}`);
    console.log('  some other way. nothing here would be lost by clearing it.');
  } else if (story.landedElsewhere > 0) {
    console.log(`  bottom line: ${story.landedElsewhere} of ${story.changes.length} changes made it into ${story.base} another`);
    console.log(`  way. ${story.uniqueChanges} exist only here (marked "never made it") — they may have`);
    console.log('  been redone differently, or they may be real lost work. clearing backs');
    console.log('  them up first either way.');
  } else {
    console.log(`  bottom line: none of this is in ${story.base}. this is real work that only`);
    console.log('  exists here. land it or clear it knowing the backup keeps a copy.');
  }
  console.log('');
  console.log(`  see the actual changes: git diff ${story.base}...${story.name}`);
  console.log('');
}

function printBoard(board) {
  console.log('');
  console.log('the landing — what is actually done vs still in the air');
  console.log('');
  if (board.branches.length === 0 && board.worktrees.length === 0) {
    console.log('  everything has landed. nothing in the air, nothing stuck.');
    console.log('');
    return;
  }
  const order = { due: 0, detached: 0, landed: 1, active: 2 };
  const rows = [...board.branches].sort((a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3) || b.ageDays - a.ageDays);
  const labels = { due: 'overdue', landed: 'landed', active: 'in the air' };
  for (const b of rows) {
    const changes = b.ahead === 1 ? '1 change ' : `${b.ahead} changes`;
    console.log(`  ${(labels[b.state] || b.state).padEnd(11)} ${String(b.ageDays).padStart(3)}d  ${changes}  ${b.name}`);
  }
  for (const w of board.worktrees) {
    const edits = w.dirty === 1 ? '1 unsaved edit' : `${w.dirty} unsaved edits`;
    console.log(`  side copy   ${w.path} (${edits})`);
  }
  console.log('');
  const s = board.summary;
  console.log(`  ${s.unlanded} pieces of work in the air, ${s.due} overdue, ${s.landed} landed and safe to clear.`);
  console.log('  work counts as done only when it lands in master.');
  if (s.due + s.landed > 0) {
    console.log(`  back up + clear the ${s.due + s.landed} overdue/landed: atris land --reap`);
  }
  console.log('');
}

function printReceipt(receipt) {
  console.log('');
  if (receipt.dryRun) {
    console.log(`landing cleanup preview — would clear ${receipt.deletedBranches.length} pieces of work, ${receipt.removedWorktrees.length} side copies:`);
    for (const b of receipt.deletedBranches) console.log(`  would clear  ${b}`);
    for (const w of receipt.removedWorktrees) console.log(`  would remove ${w}`);
  } else {
    console.log(`landing cleanup done — ${receipt.deletedBranches.length} pieces cleared, ${receipt.removedWorktrees.length} side copies removed`);
    if (receipt.bundle) console.log(`  backed up first, nothing lost: ${receipt.bundle}`);
    if (receipt.bundleError) console.log(`  backup failed — unlanded work left in place: ${receipt.bundleError}`);
    for (const p of receipt.patches) console.log(`  unsaved edits saved: ${p}`);
    for (const u of receipt.untracked || []) console.log(`  new files saved: ${u}`);
    // fresh-grace keeps are healthy active work, not a call to action —
    // "needs a human" on those trained readers to ignore the real ones.
    for (const k of receipt.keptWorktrees || []) {
      if (String(k).includes('(fresh_worktree_grace)')) console.log(`  in use, left alone: ${k.replace(' (fresh_worktree_grace)', '')}`);
      else console.log(`  ✋ kept, needs a human: ${k}`);
    }
    for (const m of receipt.keptMovedBranches || []) console.log(`  moved since scan, left alone: ${m}`);
    if (receipt.deletedRemote.length > 0) console.log(`  also cleared on github: ${receipt.deletedRemote.length}`);
  }
  console.log(`  still flying (recent work, left alone): ${receipt.kept.length}`);
  console.log('');
}

function readFlag(args, name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

function showHelp() {
  console.log('');
  console.log('atris land — the landing: what is actually done vs still in the air');
  console.log('');
  console.log('work counts as done only when it lands in master. everything else is');
  console.log('in the air, and this shows it so nothing quietly dies.');
  console.log('');
  console.log('  atris land                     show everything still in the air');
  console.log('  atris land status              show everything still in the air');
  console.log('  atris land <name>              the story of one piece: what it tried,');
  console.log('  atris land status <name>       same story lookup from status mode');
  console.log('                                 whether it landed some other way, what');
  console.log('                                 would be lost by clearing it');
  console.log('  atris land --reap              back up, then clear anything overdue');
  console.log('                                 or already landed (here and on github)');
  console.log('  atris land --reap --dry-run    preview what would be cleared');
  console.log('  atris land --ttl <days>        change the 7-day overdue line');
  console.log('  atris land --json              machine-readable output');
  console.log('');
  console.log('backups go to .atris/salvage/<date>/ — clearing never loses work.');
  console.log('');
}

function landCommand(args = []) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return 0;
  }
  const root = repoRoot();
  if (!root) {
    console.error('not a git repository');
    return 1;
  }
  const ttlRaw = readFlag(args, '--ttl', '');
  const ttlParsed = Number(ttlRaw);
  const ttlDays = ttlRaw !== '' && Number.isFinite(ttlParsed) && ttlParsed >= 0 ? ttlParsed : DEFAULT_TTL_DAYS;
  const base = readFlag(args, '--base', '');
  const json = args.includes('--json');

  if (args.includes('--reap')) {
    const receipt = reap(root, { ttlDays, base, dryRun: args.includes('--dry-run'), remote: !args.includes('--no-remote') });
    if (json) console.log(JSON.stringify(receipt, null, 2));
    else printReceipt(receipt);
    return 0;
  }

  const lookupArgs = args[0] === 'status' ? args.slice(1) : args;
  const name = lookupArgs.find((a) => !a.startsWith('-') && a !== readFlag(lookupArgs, '--ttl') && a !== readFlag(lookupArgs, '--base'));
  if (name) {
    const story = collectStory(root, name, { base });
    if (!story) {
      console.error(`nothing called '${name}' is in the air right now`);
      return 1;
    }
    if (json) console.log(JSON.stringify(story, null, 2));
    else printStory(story);
    return 0;
  }

  const board = collectBoard(root, { ttlDays, base });
  if (json) console.log(JSON.stringify(board, null, 2));
  else printBoard(board);
  return 0;
}

module.exports = {
  collectBoard,
  landCommand,
  landSummary,
  reap,
};

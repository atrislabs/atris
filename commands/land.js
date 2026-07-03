const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { listWorktrees, statusCounts } = require('./worktree');

const DEFAULT_TTL_DAYS = 7;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function runGit(args, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
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
  if (refExists(root, 'master')) return 'master';
  if (refExists(root, 'main')) return 'main';
  return '';
}

function ageDays(unixSeconds, now = Date.now()) {
  return Math.floor((now / 1000 - Number(unixSeconds)) / 86400);
}

function listBranches(root) {
  const result = runGit(
    ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)'],
    { cwd: root, check: false }
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, date] = line.split('\t');
      return { name, lastCommitUnix: Number(date) };
    });
}

function aheadCount(root, base, ref) {
  const result = runGit(['rev-list', '--count', `${base}..${ref}`], { cwd: root, check: false });
  if (result.status !== 0) return 0;
  return Number(result.stdout.trim()) || 0;
}

// Board: every branch and worktree with unlanded state, classified.
//   landed — no commits ahead of base; the branch pointer is residue
//   active — has unlanded commits, younger than TTL
//   due    — has unlanded commits, older than TTL; --reap collects it
function collectBoard(root, { ttlDays = DEFAULT_TTL_DAYS, base: baseOverride = '' } = {}) {
  const base = baseBranch(root, baseOverride);
  if (!base) throw new Error('no master/main branch found');

  const branches = [];
  for (const branch of listBranches(root)) {
    if (PROTECTED_BRANCHES.has(branch.name)) continue;
    const ahead = aheadCount(root, base, branch.name);
    const age = ageDays(branch.lastCommitUnix);
    let state = 'active';
    if (ahead === 0) state = 'landed';
    else if (age > ttlDays) state = 'due';
    branches.push({ name: branch.name, ahead, ageDays: age, state });
  }

  const worktrees = [];
  const all = listWorktrees(root);
  for (const wt of all.slice(1)) {
    const branch = (wt.branch || '').replace(/^refs\/heads\//, '');
    const counts = statusCounts(wt.path) || { staged: 0, unstaged: 0, untracked: 0 };
    const dirty = counts.staged + counts.unstaged + counts.untracked;
    const entry = branches.find((b) => b.name === branch) || null;
    worktrees.push({
      path: wt.path,
      branch,
      dirty,
      ageDays: entry ? entry.ageDays : null,
      state: entry ? entry.state : 'detached',
    });
  }

  const due = branches.filter((b) => b.state === 'due');
  const landed = branches.filter((b) => b.state === 'landed');
  const active = branches.filter((b) => b.state === 'active');
  return {
    base,
    ttlDays,
    branches,
    worktrees,
    summary: {
      unlanded: branches.length,
      active: active.length,
      due: due.length,
      landed: landed.length,
      worktrees: worktrees.length,
    },
  };
}

// Fast counts for the boot banner: no per-branch ahead checks.
function landSummary(cwd = process.cwd(), ttlDays = DEFAULT_TTL_DAYS) {
  const root = repoRoot(cwd);
  if (!root) return null;
  let branches = 0;
  let due = 0;
  for (const branch of listBranches(root)) {
    if (PROTECTED_BRANCHES.has(branch.name)) continue;
    branches += 1;
    if (ageDays(branch.lastCommitUnix) > ttlDays) due += 1;
  }
  return { branches, due, ttlDays };
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

// Reap: salvage then delete everything landed (residue) or past TTL.
// Salvage first, always: unlanded commits go into a git bundle, dirty
// worktrees into patch files, so a reap is never a loss of work.
// includeDetached: detached-HEAD worktrees have no branch, so the salvage
// bundle cannot cover their commits — unattended reaps (autoland) pass false
// and leave them for a human reap.
function reap(root, { ttlDays = DEFAULT_TTL_DAYS, base: baseOverride = '', dryRun = false, remote = true, includeDetached = true } = {}) {
  const board = collectBoard(root, { ttlDays, base: baseOverride });
  const targets = board.branches.filter((b) => b.state === 'landed' || b.state === 'due');
  const targetNames = new Set(targets.map((b) => b.name));
  const worktreeTargets = board.worktrees.filter(
    (w) => targetNames.has(w.branch) || (includeDetached && w.state === 'detached') || (typeof w.ageDays === 'number' && w.ageDays > ttlDays)
  );
  for (const w of worktreeTargets) {
    if (w.branch && !targetNames.has(w.branch)) targetNames.add(w.branch);
  }

  const receipt = {
    base: board.base,
    ttlDays,
    dryRun,
    bundle: null,
    patches: [],
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
  }

  for (const w of worktreeTargets) {
    if (w.dirty > 0) {
      const diff = runGit(['diff'], { cwd: w.path, check: false });
      if (diff.status === 0 && diff.stdout.trim()) {
        const patchPath = path.join(dir, `${path.basename(w.path)}.dirty.patch`);
        fs.writeFileSync(patchPath, diff.stdout);
        receipt.patches.push(patchPath);
      }
    }
    const removed = runGit(['worktree', 'remove', '--force', w.path], { cwd: root, check: false });
    if (removed.status === 0) receipt.removedWorktrees.push(w.path);
  }

  for (const name of targetNames) {
    const deleted = runGit(['branch', '-D', name], { cwd: root, check: false });
    if (deleted.status === 0) receipt.deletedBranches.push(name);
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
    for (const p of receipt.patches) console.log(`  unsaved edits saved: ${p}`);
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
  console.log('  atris land <name>              the story of one piece: what it tried,');
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

  const name = args.find((a) => !a.startsWith('-') && a !== readFlag(args, '--ttl') && a !== readFlag(args, '--base'));
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

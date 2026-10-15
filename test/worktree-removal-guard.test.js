'use strict';

// Engine work folders are never removed while a run is inside them, and every
// removal leaves one line saying who removed it and why. Git mid-operation in
// the folder (lock held, rebase or merge paused) holds removal the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { reap, removalsTodayLine } = require('../commands/land');
const { cleanupWorktrees, describeGitHold } = require('../commands/worktree');
const { disposeReviewSandbox, describeKeptReview } = require('../lib/fleet');
const { regressionCheck } = require('../commands/autopilot');
const { dropScratch } = require('../lib/land-green');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// A repo with one landed branch checked out in an aged sibling folder.
function landedWorktree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-removal-guard-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['branch', 'engine-run']);
  const wt = path.join(base, 'engine-wt');
  git(repo, ['worktree', 'add', '-q', wt, 'engine-run']);
  const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(wt, aged, aged);
  return { base, repo, wt };
}

function removalLines(repo) {
  const file = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('reap keeps a folder a run is working in, even with --force', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [path.join(wt, 'sub')] });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(receipt.removedWorktrees, []);
    assert.ok(receipt.keptWorktrees.some((line) => line.includes('active_process')), JSON.stringify(receipt));
    assert.ok(!receipt.deletedBranches.includes('engine-run'));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap sees a real live process in the folder without being told', async () => {
  const { base, repo, wt } = landedWorktree();
  const child = spawn('sleep', ['30'], { cwd: wt, stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const receipt = reap(repo, { remote: false });
    assert.ok(fs.existsSync(wt), JSON.stringify(receipt));
    assert.ok(receipt.keptWorktrees.some((line) => line.includes('active_process')), JSON.stringify(receipt));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap names who removed a folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const receipt = reap(repo, { remote: false, activeCwds: [], by: 'atris autoland' });
    assert.deepEqual(receipt.removedWorktrees, [wt]);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.branch, 'engine-run');
    assert.equal(line.by, 'atris autoland');
    assert.equal(line.reason, 'branch_landed');
    assert.equal(line.pid, process.pid);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The log is read back: one line counts today's removals by who did them,
// leaving out yesterday and skipping a torn last write.
test('reap summary counts folders removed today and by whom', () => {
  const { base, repo } = landedWorktree();
  try {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const file = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { at: at(13, 23), by: 'atris worktree cleanup' },
      { at: at(14, 1), by: 'atris land --reap' },
      { at: at(14, 9), by: 'atris member tidy' },
      { at: at(14, 10), by: 'atris member tidy' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n{"at":"2026-10-14T1');
    assert.equal(removalsTodayLine(repo, now), '  folders removed today: 3 (atris member tidy 2, atris land --reap 1)');
    fs.rmSync(file);
    assert.equal(removalsTodayLine(repo, now), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup names who removed a folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(wt), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris worktree cleanup');
    assert.equal(line.reason, 'merged_into_base');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function worktreeGitDir(wt) {
  return git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']);
}

test('reap keeps a folder while git holds its lock, even with --force', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(fs.existsSync(wt), JSON.stringify(receipt));
    assert.ok(receipt.keptWorktrees.includes(`${wt} (git_lock: git holds ${lock}, 3 h old)`), JSON.stringify(receipt));
    assert.ok(!receipt.deletedBranches.includes('engine-run'));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap says which git work is paused in a folder it keeps', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`);
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(fs.existsSync(wt));
    assert.ok(receipt.keptWorktrees.includes(`${wt} (git_merge_in_progress: a merge is paused)`), JSON.stringify(receipt.keptWorktrees));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup names the lock holding a folder and how old it is', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    const held = result.kept.find((item) => item.path === wt);
    assert.equal(held.reason, 'git_lock', JSON.stringify(result.kept));
    assert.equal(held.lock, lock);
    assert.ok(held.lock_age_ms >= 3 * 60 * 60 * 1000 - 1000, String(held.lock_age_ms));
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A crashed rebase can leave its lock and its paused rebase in one store; the
// report names both so clearing the lock alone does not surprise anyone.
test('worktree cleanup names a lock and a paused rebase left in the same folder', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    fs.mkdirSync(path.join(worktreeGitDir(wt), 'rebase-merge'));
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    const held = result.kept.find((item) => item.path === wt);
    assert.equal(held.reason, 'git_lock', JSON.stringify(result.kept));
    assert.deepEqual(held.also, [{ reason: 'git_rebase_in_progress', paused: 'a rebase is paused' }]);
    assert.equal(describeGitHold(held), `git holds ${lock}, 3 h old and a rebase is paused`);
    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup keeps a clean folder paused mid-rebase', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    fs.mkdirSync(path.join(worktreeGitDir(wt), 'rebase-merge'));
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(wt));
    assert.ok(result.kept.some((item) => item.path === wt && item.reason === 'git_rebase_in_progress'), JSON.stringify(result.kept));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// One stale lock reads the same in every cleanup that keeps a folder for it,
// so an operator can search one phrase across reap, cleanup and fleet logs.
test('reap, worktree cleanup and fleet review name a held lock in the same words', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const words = `git holds ${lock}, 3 h old`;
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(receipt.keptWorktrees.includes(`${wt} (git_lock: ${words})`), JSON.stringify(receipt.keptWorktrees));
    const cleaned = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(describeGitHold(cleaned.kept.find((item) => item.path === wt)), words);
    const quarantine = path.join(base, 'quarantine.git');
    fs.mkdirSync(quarantine);
    const disposed = disposeReviewSandbox({ trustedRoot: repo, sandboxRoot: path.join(base, 'sandbox'), worktreePath: wt, gitDir: path.join(base, 'sandbox.git'), quarantine });
    assert.equal(describeGitHold(disposed), words);
    assert.equal(describeGitHold({ reason: 'git_rebase_in_progress' }), 'a rebase is paused');
    assert.equal(describeGitHold({ reason: 'dirty' }), null);
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Shaped like the fleet review sandbox. Its own git dir points at a throwaway
// path so disposal never deletes the fixture repo's .git. With a store, the
// copy is checked out from its own clone at that path, as fleet review makes
// it, so git's removal there can succeed or refuse for real.
function reviewSandbox({ store = false } = {}) {
  const { base, repo, wt: repoCopy } = landedWorktree();
  const quarantine = path.join(base, 'quarantine.git');
  fs.mkdirSync(quarantine);
  const gitDir = path.join(base, 'sandbox.git');
  let wt = repoCopy;
  if (store) {
    git(base, ['clone', '-q', '--bare', repo, gitDir]);
    wt = path.join(base, 'review-wt');
    git(base, ['--git-dir', gitDir, 'worktree', 'add', '-q', wt, 'engine-run']);
  }
  return { base, repo, wt, boundary: { trustedRoot: repo, sandboxRoot: path.join(base, 'sandbox'), worktreePath: wt, gitDir, quarantine } };
}

// The store a review copy is registered in, read from git itself.
function registeredIn(gitDir, wt) {
  return git(gitDir, ['--git-dir', gitDir, 'worktree', 'list', '--porcelain'])
    .split('\n').includes(`worktree ${wt}`);
}

test('fleet review cleanup keeps a sandbox while git holds its lock', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_lock', lock });
    assert.ok(age >= 3 * 60 * 60 * 1000 - 1000, String(age));
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.existsSync(boundary.quarantine));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup says which git work is paused in a copy it keeps', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`);
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_merge_in_progress', paused: 'a merge is paused' });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup keeps a sandbox while git holds its quarantine store', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    git(base, ['init', '-q', '--bare', boundary.quarantine]);
    const lock = path.join(boundary.quarantine, 'HEAD.lock');
    fs.writeFileSync(lock, '');
    const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_lock', lock });
    assert.equal(typeof age, 'number');
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.existsSync(path.join(boundary.quarantine, 'HEAD')));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup keeps a sandbox while git updates a branch in either store', () => {
  for (const store of ['gitDir', 'quarantine']) {
    for (const marker of ['packed-refs.lock', 'refs/heads/review.lock']) {
      const { base, repo, wt, boundary } = reviewSandbox();
      try {
        git(base, ['init', '-q', '--bare', boundary.gitDir]);
        git(base, ['init', '-q', '--bare', boundary.quarantine]);
        const lock = path.join(boundary[store], marker);
        fs.writeFileSync(lock, '');
        const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
        assert.deepEqual(result, { removed: false, reason: 'git_lock', lock }, `${store} ${marker}`);
        assert.equal(typeof age, 'number', `${store} ${marker}`);
        assert.ok([wt, boundary.gitDir, boundary.quarantine].every((folder) => fs.existsSync(folder)), `${store} ${marker}`);
        assert.deepEqual(removalLines(repo), []);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  }
});

// Paused work in one store and a lock in another: every store stays, and the
// report names both holds, work folder first, so one pass can clear them.
test('fleet review cleanup keeps every store and names both holds when paused work and a lock sit in different stores', () => {
  for (const pausedFirst of [true, false]) {
    const { base, repo, wt, boundary } = reviewSandbox();
    try {
      git(base, ['init', '-q', '--bare', boundary.gitDir]);
      git(base, ['init', '-q', '--bare', boundary.quarantine]);
      const lock = pausedFirst ? path.join(boundary.quarantine, 'HEAD.lock') : path.join(worktreeGitDir(wt), 'index.lock');
      const paused = pausedFirst ? path.join(worktreeGitDir(wt), 'rebase-merge') : path.join(boundary.quarantine, 'rebase-merge');
      fs.writeFileSync(lock, '');
      fs.mkdirSync(paused);
      const result = disposeReviewSandbox(boundary);
      const label = pausedFirst ? 'paused in the work folder' : 'lock in the work folder';
      const rebase = { reason: 'git_rebase_in_progress', paused: 'a rebase is paused' };
      const held = { reason: 'git_lock', lock, lock_age_ms: result.lock_age_ms ?? result.also?.[0]?.lock_age_ms };
      assert.equal(typeof held.lock_age_ms, 'number', label);
      assert.deepEqual(result, pausedFirst
        ? { removed: false, ...rebase, also: [held] }
        : { removed: false, ...held, also: [rebase] }, label);
      const lockWords = `git holds ${lock}, under a minute old`;
      assert.equal(describeGitHold(result),
        pausedFirst ? `a rebase is paused and ${lockWords}` : `${lockWords} and a rebase is paused`, label);
      assert.ok([wt, boundary.gitDir, boundary.quarantine, lock, paused].every((file) => fs.existsSync(file)), label);
      assert.deepEqual(removalLines(repo), [], label);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test('fleet review cleanup names who removed a sandbox and why', () => {
  const { base, repo, wt, boundary } = reviewSandbox({ store: true });
  try {
    // The copy belongs to the review store, so git's own removal succeeds
    // here and this control does not rest on a refusal being ignored.
    assert.ok(registeredIn(boundary.gitDir, wt), 'review copy is registered in its own store');
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: true });
    assert.equal(fs.existsSync(wt), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris fleet review');
    assert.equal(line.reason, 'review_sandbox_imported');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// One recorded tick whose verify command runs inside the regression folder.
function regressionRepo(verifyCmd) {
  const { base, repo } = landedWorktree();
  const hash = git(repo, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(repo, 'atris'));
  fs.writeFileSync(path.join(repo, 'atris', 'tick-registry.json'), JSON.stringify([{ hash, verifyCmd, slug: 'fixture' }]));
  return { base, repo, folder: path.join(repo, `.regression-worktree-${hash.slice(0, 8)}`) };
}

test('autopilot regression check keeps its folder while git holds its lock', () => {
  const { base, repo, folder } = regressionRepo('touch "$(git rev-parse --git-dir)/index.lock"');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [] });
    assert.equal(row.kept, 'git_lock', JSON.stringify(row));
    assert.equal(row.held, `git holds ${path.join(worktreeGitDir(folder), 'index.lock')}, under a minute old`);
    assert.equal(row.path, folder);
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('autopilot regression check keeps its folder while a run is inside it', () => {
  const { base, repo, folder } = regressionRepo('true');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [path.join(folder, 'sub')] });
    assert.equal(row.kept, 'active_process', JSON.stringify(row));
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The verify step leaves a real child running in the folder, the way a
// timed-out verify can. No process list is passed in, so the real scan runs.
test('autopilot regression check sees a real leftover process without being told', () => {
  const { base, repo, folder } = regressionRepo('');
  const pidFile = path.join(base, 'leftover.pid');
  const registry = path.join(repo, 'atris', 'tick-registry.json');
  const [entry] = JSON.parse(fs.readFileSync(registry, 'utf8'));
  entry.verifyCmd = `nohup sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"`;
  fs.writeFileSync(registry, JSON.stringify([entry]));
  try {
    const [row] = regressionCheck(repo);
    assert.equal(row.kept, 'active_process', JSON.stringify(row));
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('autopilot regression check names who removed its folder and why', () => {
  const { base, repo, folder } = regressionRepo('true');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [] });
    assert.equal(row.pass, true);
    assert.equal(row.kept, undefined);
    assert.equal(fs.existsSync(folder), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, folder);
    assert.equal(line.by, 'atris autopilot regression check');
    assert.equal(line.reason, 'regression_check_done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

for (const dirty of [false, true]) {
  test(`autopilot regression check keeps an existing ${dirty ? 'dirty' : 'clean'} folder when creation fails`, () => {
    const { base, repo, folder } = regressionRepo('touch verify-ran');
    try {
      git(repo, ['worktree', 'add', '-q', '--detach', folder, 'HEAD']);
      const head = git(folder, ['rev-parse', 'HEAD']);
      if (dirty) fs.writeFileSync(path.join(folder, 'unfinished.txt'), 'keep this work\n');
      const [row] = regressionCheck(repo, { activeCwds: [] });
      assert.equal(row.skipped, true, JSON.stringify(row));
      assert.ok(fs.existsSync(folder), 'the folder existed before this invocation');
      assert.equal(git(folder, ['rev-parse', 'HEAD']), head);
      assert.ok(git(repo, ['worktree', 'list']).includes(folder));
      assert.equal(fs.existsSync(path.join(folder, 'verify-ran')), false);
      if (dirty) assert.equal(fs.readFileSync(path.join(folder, 'unfinished.txt'), 'utf8'), 'keep this work\n');
      assert.deepEqual(removalLines(repo), []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

// Tripwire: a work folder removal anywhere in lib/ or commands/, by git or by a
// raw delete of a worktree path, must sit in a function whose git-activity
// check, written above the delete with an answer that can stop it, and removal
// log name the folder it deletes. A new file that removes folders is caught
// too. Exceptions need a reason; stale entries fail.
function sourceFiles(dir) {
  return fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(relative);
    return relative.endsWith('.js') ? [relative] : [];
  });
}
// An exemption names a function and lists the folder each of its deletes
// removes today, so a new delete added to an exempt function fails, naming its
// line and folder, until someone reviews it.
const UNGUARDED_REMOVALS = {
  'commands/worktree.js:createAgentWorktree': { deletes: ['target'], why: 'drops a folder it just made before any engine entered; plain remove refuses dirt' },
  'lib/fleet.js:prepareReviewSandbox': { deletes: ['seedDir', 'worktreePath', 'gitDir', 'quarantine', 'sandboxRoot', 'seedDir'], why: 'wipes its own temp sandbox when setup fails, and its seed folder after; only that call touched them, so any lock is stale' },
  'commands/drill.js:landingShippedLocal': { deletes: ['ctx.landingWorktree'], why: 'removes a worktree inside the drill\'s own throwaway practice repo' },
  'lib/land-green.js:scratchCheckout': { deletes: ['dir'], why: 'drops its fresh temp folder only after git failed to make it a worktree' },
};
// Real work folder removals still waiting for the guard. Each one is a gap;
// guard it and delete its line here.
const NOT_YET_GUARDED = {
};
const WORKTREE_REMOVAL = /worktree['"]?\s*,\s*['"]remove['"]|git worktree remove|\brm(?:dir)?(?:Sync)?\(\s*[^,)]*(?:worktree|wtPath|\bwt\b|\bw\.path)|\brm\s+-[a-z]*r[^;&|\n]*(?:worktree|wtPath|\bwt\b)|['"]rm['"]\s*,\s*\[[^\]]*(?:worktree|wtPath|\bwt\b)/i;
// A recursive delete with a plain name (dir, target) still counts when its
// function lists, adds, removes, or walks worktrees, so renaming a variable can't hide one.
// Asking git for the worktree list directly counts as listing them.
// Callback and promise deletes (fs.rm, fs.promises.rm) count the same as rmSync,
// and so does a shell rm -r, typed out or passed to spawn as arguments.
// A path built by a call, like rmSync(path.join(root, x), { recursive }), is read through.
// The older rmdir with the recursive option counts as a delete too.
const RECURSIVE_DELETE = /\brm(?:dir)?(?:Sync)?\((?:[^()]|\([^()]*\))*recursive|\brm\s+-[a-zA-Z]*[rR]|['"]rm['"]\s*,\s*\[\s*['"]-[a-zA-Z]*[rR]/;
const HANDLES_WORKTREES = /listWorktrees\(|parseWorktrees\(|agent-worktrees|['"]worktree['"]\s*,\s*['"](?:add|list|remove)['"]|git worktree (?:add|list|remove)/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

// A delete split across lines is read from its opening line to the line that
// closes the call, so moving arguments onto their own lines can't hide one.
function callText(lines, index) {
  let depth = 0;
  for (let end = index; end < lines.length && end < index + 12; end++) {
    for (const ch of lines[end]) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth <= 0) return lines.slice(index, end + 1).join('\n');
  }
  return lines.slice(index, index + 12).join('\n');
}

// A line with its quoted text, regex text, and trailing comment emptied, so
// a brace inside '{' or /\{\{/ never opens or closes a helper.
function codeOnly(line) {
  if (COMMENT_LINE.test(line)) return '';
  return line
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/(^|[(,=:[!&|?{};]|\breturn)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+\/[a-z]*/g, '$1$20')
    .replace(/\/\/.*$/, '');
}

// The line that closes the brace a helper opens, or, for an arrow with no
// braces, the line that ends its expression with a comma or semicolon once
// every bracket it opened is closed.
function helperEnd(lines, index) {
  let depth = 0;
  let opened = false;
  for (let end = index; end < lines.length; end++) {
    const code = codeOnly(lines[end]);
    for (const ch of code) {
      if (ch === '{') opened = true;
      if ('{[('.includes(ch)) depth++; else if ('}])'.includes(ch)) depth--;
    }
    if (depth <= 0 && (opened || /[;,]\s*$/.test(code))) return end;
  }
  return lines.length - 1;
}

// Keywords whose line can look like a method or helper start.
const NOT_A_HELPER = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);
// A helper can be a plain function at any depth, a named arrow (const wipe =
// (dir) => or wipe: dir =>), or a class or object method (wipe(dir) {).
const HELPER_START = [
  /^\s*(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)/,
  /^\s*(?:(?:export\s+)?(?:const|let|var)\s+)?([\w$]+)\s*[=:]\s*(?:async\s+)?(?:function\s*)?\(([^()]*)\)\s*(?:=>|\{)/,
  /^\s*(?:(?:export\s+)?(?:const|let|var)\s+)?([\w$]+)\s*[=:]\s*(?:async\s+)?([\w$]+)\s*=>/,
  /^\s+(?:static\s+)?(?:async\s+)?([\w$]+)\s*\(([^()]*)\)\s*\{/,
];

// Every function start both scans read, with its parameters and the line that
// ends it. A top start owns the deletes inside it in the main scan: a plain
// function, a named arrow or function expression at the left margin, or a
// method of a top-level class. An arrow nested inside a function stays part
// of that function there, so the guard above it still counts and its key does
// not move. The passed-in check reads every start, nested ones too.
function functionStarts(lines) {
  let inClass = false;
  return lines.flatMap((line, index) => {
    if (/^(?:export\s+)?class\s/.test(line)) inClass = true;
    else if (/^}/.test(line)) inClass = false;
    const top = line.match(/^(?:async\s+)?function\s+([\w$]+)/)
      || line.match(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/)
      || (inClass && line.match(/^ {2}(?:static\s+)?(?:async\s+)?([\w$]+)\s*\([^()]*\)\s*\{/));
    const helper = HELPER_START.map((pattern) => line.match(pattern)).find(Boolean);
    const match = top || helper;
    if (!match || NOT_A_HELPER.has(match[1])) return [];
    const params = (helper ? helper[2] : '').split(',')
      .map((part) => part.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, ''))
      .filter((part) => /^[\w$]+$/.test(part));
    return [{ name: match[1], params, index, end: helperEnd(lines, index), top: Boolean(top) }];
  });
}

function worktreeRemovalSites(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const starts = functionStarts(lines).filter((start) => start.top);
  const sites = [];
  lines.forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return;
    const call = /\brm(?:dir)?(?:Sync)?\(|['"]rm['"]\s*,/.test(line) ? callText(lines, index) : line;
    const named = WORKTREE_REMOVAL.test(call);
    if (!named && !RECURSIVE_DELETE.test(call)) return;
    // A function's lines run to its closing brace. A delete outside every
    // function is read from the end of the last function above it, so that
    // function's git check never counts for it.
    const owner = starts.filter((start) => start.index <= index && index <= start.end).pop();
    const next = starts.find((start) => start.index > index);
    const from = owner ? owner.index : starts.filter((start) => start.end < index)
      .reduce((at, start) => Math.max(at, start.end + 1), 0);
    const to = owner ? owner.end + 1 : next ? next.index : lines.length;
    // Comments are dropped so a note naming the check never counts as the check.
    const code = (from, to) => lines.slice(from, to)
      .filter((text) => !COMMENT_LINE.test(text))
      .map((text) => text.replace(/\s\/\/.*$/, ''))
      .join('\n');
    const body = code(from, to);
    if (!named && !HANDLES_WORKTREES.test(body)) return;
    // The function's code above the delete, where its git check has to sit.
    const before = code(from, index);
    sites.push({ key: `${file}:${owner ? owner.name : '(top level)'}`, line: index + 1, call, body, before });
  });
  return sites;
}

// A cleanup that deletes a set of folders together checks every git store
// before the first delete and writes one log line for the set. Each listed
// check must be present, the log must name the work folder, and the deletes
// are listed by folder so a new delete in the set gets reviewed.
const GROUPED_REMOVALS = {
  'lib/fleet.js:disposeReviewSandbox': {
    deletes: ['boundary.worktreePath', 'boundary.worktreePath', 'boundary.gitDir', 'boundary.quarantine', 'boundary.sandboxRoot'],
    checks: ['gitHold({ worktree: boundary.worktreePath, stores: [boundary.gitDir, boundary.quarantine] })'],
    logs: 'boundary.worktreePath',
    why: 'review sandbox: work folder, its git store, the quarantine store, and their parent go together',
  },
};

// The first argument of a call, read up to the comma or paren that closes it.
function firstArgument(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth++;
    else if (depth === 0 && (ch === ',' || ch === ')')) return text.slice(0, i).replace(/\s+/g, '');
    else if (')]}'.includes(ch)) depth--;
  }
  return '';
}

// The folder a delete removes, as written in the source. An empty answer
// means the scan could not read it, which counts as a gap, never a pass.
function removedTarget(call, body) {
  const typed = call.match(/(?:git worktree remove|\brm\s+-[a-zA-Z]*[rR])[^`\n]*?\$\{([^}]+)\}/);
  if (typed) return typed[1].replace(/\s+/g, '');
  const rm = call.match(/\brm(?:dir)?(?:Sync)?\(/);
  if (rm) return firstArgument(call.slice(rm.index + rm[0].length));
  const list = call.match(/(?:['"]worktree['"]\s*,\s*['"]remove['"]|['"]rm['"]\s*,\s*\[)([^\]]*)\]/);
  if (!list) return '';
  const unquoted = (part) => part && !/^['"`]/.test(part);
  // The folder is the last unquoted entry; options like '--force' may follow it.
  const last = list[1].split(',').map((part) => part.trim()).filter(unquoted).pop();
  if (last) return last.replace(/\s+/g, '');
  // Arguments pushed onto a named list after it is built, like removeArgs.push(wt.path).
  const named = call.match(/([\w$]+)\s*=\s*\[\s*['"]worktree['"]/);
  if (!named) return '';
  const pushed = [...body.matchAll(new RegExp(`\\b${named[1]}\\.push\\(([^()]*)\\)`, 'g'))]
    .map((match) => match[1].trim()).filter(unquoted);
  return pushed.length ? pushed.pop().replace(/\s+/g, '') : '';
}

// Names made by path.resolve or realpath of another name point at the same folder.
function sameFolder(body) {
  const from = new Map();
  for (const [, alias, original] of body.matchAll(/([\w$]+)\s*=\s*(?:path\.resolve|fs\.realpathSync(?:\.native)?)\(\s*([\w$.]+)\s*\)/g)) {
    from.set(alias, original);
  }
  return (name) => {
    const seen = new Set();
    while (from.has(name) && !seen.has(name)) { seen.add(name); name = from.get(name); }
    return name;
  };
}

// The folder a git check reads: the shared gitHold({ worktree: <folder> }) or
// the plain worktreeGitActivity(<folder>) check.
function checkedCalls(body) {
  return [...body.matchAll(/gitHold\(\s*\{\s*worktree:\s*([^,{}()]+?)\s*[,}]|worktreeGitActivity\(\s*([^()]*?)\s*\)/g)]
    .map((match) => ({ arg: (match[1] || match[2]).replace(/\s+/g, ''), index: match.index }));
}

// Just past the bracket that closes the one at start, or -1 when the text ends
// first, which means the delete sits inside it.
function closing(text, start) {
  const open = text[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

// A check protects only when its answer can stop the delete: an if on the
// answer that returns, continues, breaks, or throws, or an if on the negated
// answer whose branch holds the delete. The answer is read in place or through
// the name it was stored under.
function answerStops(before, at) {
  const start = Math.max(before.lastIndexOf(';', at), before.lastIndexOf('{', at), before.lastIndexOf('}', at)) + 1;
  const stored = before.slice(start, at).match(/^\s*(?:(?:const|let|var)\s+)?([\w$]+)\s*=(?!=)/);
  for (const match of before.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = closing(before, open);
    if (end < 0) continue;
    const condition = before.slice(open, end);
    const inPlace = open < at && at < end;
    const byName = stored && match.index > at && new RegExp(`(?:^|[^\\w$.])${stored[1]}\\b`).test(condition);
    if (!inPlace && !byName) continue;
    const negated = inPlace
      ? /!\s*(?:[\w$]+\.)?$/.test(before.slice(open + 1, at))
      : new RegExp(`!\\s*${stored[1]}\\b`).test(condition);
    let from = end;
    while (/\s/.test(before[from] || '')) from++;
    const stop = before[from] === '{' ? closing(before, from) : before.indexOf(';', from) + 1;
    const holdsDelete = stop <= 0;
    const branch = before.slice(from, holdsDelete ? before.length : stop);
    if (!negated && !holdsDelete && /\b(?:return|continue|break|throw)\b/.test(branch)) return true;
    if (negated && holdsDelete) return true;
  }
  return false;
}

function loggedPaths(body) {
  return [...body.matchAll(/recordWorktreeRemoval\([^{]*\{[^}]*?\bpath:\s*([\w$.]+)/g)].map((match) => match[1]);
}

// Git refuses to remove a pinned folder, but a plain delete of the same
// folder after git's removal goes through anyway. A function that does both
// has to check the pin before the delete and let that answer stop it.
const GIT_REMOVAL = /['"]worktree['"]\s*,\s*['"]remove['"]|git worktree remove/;
function pinGap(site, target) {
  if (!target || GIT_REMOVAL.test(site.call)) return '';
  const folder = sameFolder(site.body);
  const afterGit = site.before.split('\n')
    .some((line) => GIT_REMOVAL.test(line) && folder(removedTarget(line, site.body)) === folder(target));
  if (!afterGit) return '';
  const pins = [...site.before.matchAll(/describePin\(\s*([^,()]+?)\s*[,)]/g)]
    .filter((match) => folder(match[1].replace(/\s+/g, '')) === folder(target));
  if (!pins.length) return `plain delete of ${target} after a git removal never checks its pin`;
  return pins.some((match) => answerStops(site.before, match.index)) ? '' : `pin check on ${target} never stops the delete`;
}

// Why a delete is not covered, in words a builder can act on, or '' when it
// is: the scan cannot tell which folder is deleted, no git check names it, the
// check only runs after the delete, its answer never stops the delete, the
// log names some other folder, or a group lost a check or its log.
function removalGap(site) {
  const group = GROUPED_REMOVALS[site.key];
  if (group) {
    for (const check of group.checks) {
      const written = new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\(/g, '\\(\\s*').replace(/\\\)/g, '\\s*\\)')).exec(site.before);
      if (!written) return `group check ${check} is missing above this delete`;
      if (!answerStops(site.before, written.index)) return `group check ${check} never stops this delete`;
    }
    const pinned = pinGap(site, removedTarget(site.call, site.body));
    if (pinned) return pinned;
    return loggedPaths(site.body).includes(group.logs) ? '' : `group removal log does not name ${group.logs}`;
  }
  const target = removedTarget(site.call, site.body);
  if (!target) return 'could not tell which folder is deleted';
  const folder = sameFolder(site.body);
  const naming = (calls) => calls.filter((check) => folder(check.arg) === folder(target));
  const above = naming(checkedCalls(site.before));
  if (!above.length) {
    return naming(checkedCalls(site.body)).length
      ? `git check on ${target} only comes after the delete`
      : `no git check names ${target}`;
  }
  if (!above.some((check) => answerStops(site.before, check.index))) return `git check answer on ${target} never stops the delete`;
  const pinned = pinGap(site, target);
  if (pinned) return pinned;
  return loggedPaths(site.body).some((logged) => folder(logged) === folder(target)) ? '' : `removal log does not name ${target}`;
}

// Deletes found in a listed function, matched against its list by folder.
// Anything left over on either side is named with its line or folder.
function listedDeleteDrift(key, listed, found) {
  const left = [...listed];
  const added = [];
  for (const site of found) {
    const target = removedTarget(site.call, site.body) || '(unreadable folder)';
    const at = left.indexOf(target);
    if (at >= 0) left.splice(at, 1);
    else added.push(`${key} (line ${site.line}): new delete of ${target}`);
  }
  return [...added, ...left.map((target) => `${key}: listed delete of ${target} is gone`)];
}

test('every work folder removal goes through the git check and the removal log', () => {
  const sites = [...sourceFiles('lib'), ...sourceFiles('commands')].flatMap(worktreeRemovalSites);
  assert.ok(sites.length >= 8, `expected the known removal sites, found ${sites.length}`);
  const bypasses = sites
    .filter((site) => !UNGUARDED_REMOVALS[site.key] && !NOT_YET_GUARDED[site.key])
    .filter((site) => removalGap(site))
    .map((site) => `${site.key} (line ${site.line}): ${removalGap(site)}`);
  assert.deepEqual(bypasses, [], 'removal without a git check and removal log naming the deleted folder');
  const stale = [...Object.keys(UNGUARDED_REMOVALS), ...Object.keys(GROUPED_REMOVALS), ...Object.keys(NOT_YET_GUARDED)]
    .filter((key) => !sites.some((site) => site.key === key));
  assert.deepEqual(stale, [], 'exception names a function that no longer removes a folder');
  const drifted = Object.entries({ ...UNGUARDED_REMOVALS, ...GROUPED_REMOVALS })
    .flatMap(([key, { deletes }]) => listedDeleteDrift(key, deletes, sites.filter((site) => site.key === key)));
  assert.deepEqual(drifted, [], 'an exempt or grouped function gained or lost a delete; review it, then update its list');
  const nowGuarded = Object.keys(NOT_YET_GUARDED).filter((key) => sites
    .filter((site) => site.key === key)
    .every((site) => !removalGap(site)));
  assert.deepEqual(nowGuarded, [], 'guarded now: delete its line from NOT_YET_GUARDED');
  // A top-level arrow and a class method own their deletes; an arrow nested
  // in a function, an if inside a class, and an indented call after the
  // class closes do not.
  const owners = functionStarts([
    'function guarded(wt) {',
    '  const done = (x) => x;',
    '}',
    'const sweep = async (wt) => {',
    'class Shelf {',
    '  static empty(wt) {',
    '  if (wt) {',
    '}',
    '  later(wt) {',
  ]).filter((start) => start.top).map((start) => start.name);
  assert.deepEqual(owners, ['guarded', 'sweep', 'empty']);
});

// A helper that deletes whatever folder its caller hands it can be given a
// work folder without ever naming one, so the scan above would never see it.
// Each such delete is either one the scan above already checks or one listed
// here after review. Stale entries fail.
const PASSED_IN_DELETES = {
  'commands/skill.js:removeLink': 'skill remove: every caller passes an installed skill folder under .claude, .codex, or .cursor',
};

function passedInDeletes(file, text) {
  const lines = text.split('\n');
  const starts = functionStarts(lines);
  return lines.flatMap((line, index) => {
    if (COMMENT_LINE.test(line)) return [];
    const call = /\brm(?:dir)?(?:Sync)?\(|['"]rm['"]\s*,/.test(line) ? callText(lines, index) : line;
    if (!RECURSIVE_DELETE.test(call)) return [];
    // Every helper whose lines hold the delete, innermost first, so a small
    // arrow defined earlier in a helper never takes the delete from it.
    const around = starts.filter((start) => start.index <= index && index <= start.end).reverse();
    for (const owner of around) {
      const body = lines.slice(owner.index, owner.end + 1).join('\n');
      const target = sameFolder(body)(removedTarget(call, body));
      if (owner.params.includes(target)) return [{ key: `${file}:${owner.name}`, line: index + 1, target }];
    }
    return [];
  });
}

test('a helper that deletes a folder its caller passed in is checked or reviewed', () => {
  const files = [...sourceFiles('lib'), ...sourceFiles('commands')];
  // Matched by file and line: the scan above names only plain functions, so an
  // arrow or method helper carries a different owner name there.
  const scanned = new Set(files.flatMap(worktreeRemovalSites).map((site) => `${site.key.split(':')[0]}:${site.line}`));
  const found = files.flatMap((file) => passedInDeletes(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8')));
  assert.ok(found.length >= 1, 'expected the green landing scratch cleanup to be found');
  const unreviewed = found
    .filter((site) => !scanned.has(`${site.key.split(':')[0]}:${site.line}`) && !PASSED_IN_DELETES[site.key])
    .map((site) => `${site.key} (line ${site.line}): deletes ${site.target}, which its caller chooses`);
  assert.deepEqual(unreviewed, [], 'guard this delete like a work folder removal, or review it and list it');
  const stale = Object.keys(PASSED_IN_DELETES).filter((key) => !found.some((site) => site.key === key));
  assert.deepEqual(stale, [], 'listed helper no longer deletes a folder its caller passed in');

  // Planted helpers in a file that never mentions worktrees are still found:
  // a plain function read through a path.resolve rename and a delete split
  // across lines, two named arrows, a class method whose delete sits in a
  // callback, and helpers holding small inner arrows. An inner arrow keeps
  // only its own lines, so the helper around it still owns a delete of its
  // folder, and an inner arrow that deletes its own argument owns that one.
  // Braces in regex or quoted text neither end a helper early nor stretch it
  // over the next one. A plain function declared inside a helper owns a
  // delete of its own argument, and a delete of the outer helper's folder
  // inside it still belongs to the outer helper.
  const planted = [
    'function wipe(folder, opts = {}) {',
    '  const where = path.resolve(folder);',
    '  fs.rmSync(',
    '    where,',
    '    { recursive: true, force: true },',
    '  );',
    '}',
    'function tidy() { fs.rmSync(cacheDir, { recursive: true }); }',
    'const clear = async (dir) => {',
    '  await fs.promises.rm(dir, { recursive: true });',
    '};',
    'const drop = dir => fs.rmSync(dir, { recursive: true });',
    'class Shelf {',
    '  empty(where) {',
    '    setTimeout(function () { fs.rmSync(where, { recursive: true, force: true }); });',
    '  }',
    '  log(dir) { console.log(dir); }',
    '}',
    'function sweep(dir) {',
    '  const note = () => console.log("sweeping");',
    '  fs.rmSync(dir, { recursive: true });',
    '}',
    'function shelve(folder) {',
    '  const where = path.resolve(folder);',
    '  const later = () => {',
    '    fs.rmSync(where, { recursive: true });',
    '  };',
    '  const each = (item) => fs.rmSync(item, { recursive: true });',
    '}',
    'function after() { fs.rmSync(dir, { recursive: true }); }',
    'function scrub(dir) {',
    '  if (/\\{\\{[^}]*\\}\\}/.test(dir)) return;',
    '  fs.rmSync(dir, { recursive: true });',
    '}',
    'function opener(dir) {',
    "  if (dir === '{') return;",
    '}',
    'function later() { fs.rmSync(dir, { recursive: true }); }',
    'function prune(list, root) {',
    '  function drop(item) {',
    '    fs.rmSync(item, { recursive: true });',
    '  }',
    '  function clean() { fs.rmSync(root, { recursive: true }); }',
    '  list.forEach(drop);',
    '}',
  ].join('\n');
  assert.ok(!WORKTREE_REMOVAL.test(planted) && !HANDLES_WORKTREES.test(planted), 'the main scan would skip this helper');
  assert.deepEqual(passedInDeletes('lib/planted.js', planted), [
    { key: 'lib/planted.js:wipe', line: 3, target: 'folder' },
    { key: 'lib/planted.js:clear', line: 10, target: 'dir' },
    { key: 'lib/planted.js:drop', line: 12, target: 'dir' },
    { key: 'lib/planted.js:empty', line: 15, target: 'where' },
    { key: 'lib/planted.js:sweep', line: 21, target: 'dir' },
    { key: 'lib/planted.js:shelve', line: 26, target: 'folder' },
    { key: 'lib/planted.js:each', line: 28, target: 'item' },
    { key: 'lib/planted.js:scrub', line: 33, target: 'dir' },
    { key: 'lib/planted.js:drop', line: 41, target: 'item' },
    { key: 'lib/planted.js:prune', line: 43, target: 'root' },
  ]);
});

test('saved scanner examples reject missed removals in the required checks', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /review gaps: 0; synthetic source only, no folders removed/);
});

test('a git check that comes late, names another folder, or is ignored does not count as protection', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-binding-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /review gaps: 0; synthetic source only, never executed/);
});

test('grouped sandbox cleanup exposes every recursive target to the scan', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-group-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /group: 4 recursive targets; 0 missing from scan; source only, no folders removed/);
});

test('green landing keeps its scratch folder while a test is still running in it, git is busy, or it is pinned', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [path.join(wt, 'node_modules')] }), { removed: false, reason: 'active_process' });
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const { lock_age_ms: age, ...held } = dropScratch(repo, wt, { activeCwds: [] });
    assert.deepEqual(held, { removed: false, reason: 'git_lock', lock });
    assert.ok(age < 60000, String(age));
    fs.rmSync(path.join(worktreeGitDir(wt), 'index.lock'));
    git(repo, ['worktree', 'lock', '--reason', 'operator checking the verify', wt]);
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [] }), { removed: false, reason: 'pinned', pinned: 'pinned by git worktree lock, under a minute old: operator checking the verify' });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('green landing names who removed its scratch folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [] }), { removed: true });
    assert.equal(fs.existsSync(wt), false);
    assert.ok(!git(repo, ['worktree', 'list']).includes(wt));
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris land --auto');
    assert.equal(line.reason, 'green_landing_scratch_done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A wrapper on PATH only times the race: the real git takes the pin, or the
// removal is stopped by a signal, after dropScratch has done its own checks.
for (const [label, onRemove, words] of [
  ['a pin taken at removal', 'pin', 'pinned by git worktree lock, under a minute old: verify still writing'],
  ['a removal stopped by a signal', 'signal', 'git removal stopped by SIGTERM'],
]) {
  test(`green landing keeps its scratch folder after ${label}`, () => {
    const { base, repo, wt } = landedWorktree();
    try {
      const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
      const bin = path.join(base, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit)};
if (args[0] === 'worktree' && args[1] === 'remove') {
  if (${JSON.stringify(onRemove)} === 'signal') process.kill(process.pid, 'SIGTERM');
  spawnSync(git, ['worktree', 'lock', '--reason', 'verify still writing', ${JSON.stringify(wt)}]);
}
const result = spawnSync(git, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
      const run = spawnSync(process.execPath, ['-e',
        `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../lib/land-green.js'))}).dropScratch(${JSON.stringify(repo)}, ${JSON.stringify(wt)}, { activeCwds: [] })))`,
      ], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { removed: false, reason: 'removal_refused', detail: words });
      assert.ok(fs.existsSync(path.join(wt, 'README.md')));
      assert.ok(git(repo, ['worktree', 'list']).includes(wt));
      assert.deepEqual(removalLines(repo), []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

// A start that fails after its folder exists takes the folder back. When git
// refuses that removal, the start error still leads and names the kept folder.
test('a failed worktree start keeps its folder after a pin taken at removal and still shows why it failed', () => {
  const { base, repo } = landedWorktree();
  try {
    const target = path.join(base, 'start-wt');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit)};
if (args[0] === 'config' && String(args[1]).endsWith('.atris-base')) {
  process.stderr.write('error: metadata write failed\\n');
  process.exit(1);
}
if (args[0] === 'worktree' && args[1] === 'remove') {
  spawnSync(git, ['worktree', 'lock', '--reason', 'editor still open', ${JSON.stringify(target)}]);
}
const result = spawnSync(git, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'start',
      '--agent', 'tester', '--task', 'failed start', '--path', target, '--base', 'HEAD',
    ], { cwd: repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /metadata write failed; kept .*start-wt: pinned by git worktree lock, under a minute old: editor still open/);
    assert.ok(fs.existsSync(path.join(target, 'README.md')));
    assert.ok(git(repo, ['worktree', 'list']).includes(target));
    assert.deepEqual(removalLines(repo).filter((line) => line.path === target), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup names the reason and age of a pinned folder it skips', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    git(repo, ['worktree', 'lock', '--reason', 'agent still writing', wt]);
    const pin = path.join(worktreeGitDir(wt), 'locked');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, stale, stale);
    const cleaned = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    const kept = cleaned.kept.find((item) => item.path === wt);
    assert.equal(kept.reason, 'locked', JSON.stringify(cleaned.kept));
    assert.equal(kept.pinned, 'pinned by git worktree lock, 3 h old: agent still writing');
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap skips a dirty pinned folder before saving its patches, even with --force', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    fs.writeFileSync(path.join(wt, 'README.md'), '# edited\n');
    git(repo, ['worktree', 'lock', '--reason', 'agent still writing', wt]);
    const pin = path.join(worktreeGitDir(wt), 'locked');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, stale, stale);
    fs.utimesSync(wt, stale, stale);
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(receipt.keptWorktrees.includes(`${wt} (pinned by git worktree lock, 3 h old: agent still writing)`), JSON.stringify(receipt.keptWorktrees));
    assert.deepEqual(receipt.patches, []);
    assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), '# edited\n');
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup keeps every store of a pinned copy and names the pin', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    git(repo, ['worktree', 'lock', '--reason', 'reviewer still reading', wt]);
    const pin = path.join(worktreeGitDir(wt), 'locked');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, stale, stale);
    fs.mkdirSync(boundary.sandboxRoot);
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'pinned', pinned: 'pinned by git worktree lock, 3 h old: reviewer still reading' });
    assert.ok([wt, boundary.quarantine, boundary.sandboxRoot].every((item) => fs.existsSync(item)));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The line fleet review prints when cleanup keeps a copy, filled with a real
// cleanup result.
function keptReviewLine(disposed, sandboxRoot) {
  return describeKeptReview('T-1', disposed, sandboxRoot);
}

test('fleet review prints its kept line through the shared helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/fleet.js'), 'utf8');
  assert.deepEqual(source.match(/^\s*log\(.*kept review sandbox.*$/gm), null, 'kept line written inline again');
  const kept = source.match(/^\s*log\(.*describeKeptReview\(.*$/gm) || [];
  assert.deepEqual(kept.map((line) => line.trim()),
    ['log(`    ${describeKeptReview(entry.taskId, disposed, entry.remoteBoundary.sandboxRoot)}`);']);
});

test('fleet review kept line prints the reason alone when nothing explains it', () => {
  assert.equal(keptReviewLine({ removed: false, reason: 'removal_refused', detail: '' }, '/tmp/review'),
    'kept review sandbox for T-1 (removal_refused): /tmp/review');
});

test('fleet review names the git lock or pin when cleanup keeps a copy', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const held = disposeReviewSandbox(boundary);
    assert.equal(held.reason, 'git_lock');
    assert.equal(keptReviewLine(held, boundary.sandboxRoot),
      `kept review sandbox for T-1 (git_lock: git holds ${lock}, under a minute old): ${boundary.sandboxRoot}`);
    fs.rmSync(lock);
    git(repo, ['worktree', 'lock', '--reason', 'reviewer still reading', wt]);
    const pinned = disposeReviewSandbox(boundary);
    assert.equal(keptReviewLine(pinned, boundary.sandboxRoot),
      `kept review sandbox for T-1 (pinned: pinned by git worktree lock, under a minute old: reviewer still reading): ${boundary.sandboxRoot}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A refusal result carries git's reason in its detail. The kept line must
// print it, not "undefined".
test('fleet review names git\'s refusal when cleanup keeps a copy', () => {
  const refused = { removed: false, reason: 'removal_refused', detail: 'git removal stopped by SIGTERM' };
  assert.equal(keptReviewLine(refused, '/tmp/review'),
    'kept review sandbox for T-1 (removal_refused: git removal stopped by SIGTERM): /tmp/review');
});

// Runs fleet review cleanup in a child whose git runs onRemove (wrapper code
// with fs, spawnSync, args and the real git in scope) once removal starts,
// then hands the call to the real git. Returns the child's run and the
// removal args git was given.
function disposeWithGitAtRemoval(base, repo, boundary, onRemove) {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(realGit.status, 0, realGit.stderr);
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const attempt = path.join(base, 'remove-attempt.json');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit.stdout.trim())};
if (args.includes('remove')) {
  fs.writeFileSync(${JSON.stringify(attempt)}, JSON.stringify(args));
  ${onRemove}
}
const result = spawnSync(git, args, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
  fs.mkdirSync(boundary.sandboxRoot);
  const run = spawnSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../lib/fleet.js'))}).disposeReviewSandbox(${JSON.stringify(boundary)})))`,
  ], { cwd: repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(run.status, 0, run.stderr);
  return { run, removal: JSON.parse(fs.readFileSync(attempt, 'utf8')) };
}

// A pin taken after the first check makes git refuse its removal. The plain
// deletes that follow must not finish what git would not, so the copy stays
// and the report uses the line tidy, reap, cleanup and autopilot print.
// Plan: atris/receipts/work-folder-review-late-pin-decision-2026-10-14.md.
test('fleet review cleanup keeps a copy pinned after its first check and names the refusal', () => {
  const { base, repo, wt, boundary } = reviewSandbox({ store: true });
  try {
    const { run, removal } = disposeWithGitAtRemoval(base, repo, boundary, `const pin = spawnSync(git, ['worktree', 'lock', '--reason', 'reviewer opened it', ${JSON.stringify(wt)}], { cwd: ${JSON.stringify(wt)}, encoding: 'utf8' });
  if (pin.status !== 0) { process.stderr.write(pin.stderr); process.exit(1); }`);
    assert.ok(removal.includes(wt));
    const words = 'pinned by git worktree lock, under a minute old: reviewer opened it';
    assert.deepEqual(JSON.parse(run.stdout), { removed: false, reason: 'removal_refused', detail: words });
    assert.ok([wt, path.join(wt, 'README.md'), boundary.quarantine, boundary.sandboxRoot].every((item) => fs.existsSync(item)));
    assert.equal(fs.readFileSync(path.join(worktreeGitDir(wt), 'locked'), 'utf8').trim(), 'reviewer opened it');
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Git can refuse with no pin at all, or be stopped before it answers. Both
// keep every store and name why, so the fix reads git's result, not just
// its pins.
test('fleet review cleanup keeps a copy git refused without a pin or never finished removing', () => {
  const cases = [
    // The copy's link to its store goes missing just as removal starts.
    { label: 'refused without a pin', onRemove: (wt) => `fs.renameSync(${JSON.stringify(path.join(wt, '.git'))}, ${JSON.stringify(path.join(wt, '.git-moved'))});`, detail: /validation failed/ },
    { label: 'stopped by a signal', onRemove: () => "process.kill(process.pid, 'SIGTERM');", detail: /^git removal stopped by SIGTERM$/ },
  ];
  for (const { label, onRemove, detail } of cases) {
    const { base, repo, wt, boundary } = reviewSandbox({ store: true });
    try {
      const { run, removal } = disposeWithGitAtRemoval(base, repo, boundary, onRemove(wt));
      assert.ok(removal.includes(wt), label);
      const result = JSON.parse(run.stdout);
      assert.deepEqual({ ...result, detail: undefined }, { removed: false, reason: 'removal_refused', detail: undefined }, label);
      assert.match(result.detail, detail, label);
      assert.ok([wt, path.join(wt, 'README.md'), boundary.gitDir, boundary.quarantine, boundary.sandboxRoot].every((item) => fs.existsSync(item)), label);
      assert.deepEqual(removalLines(repo), [], label);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test('a plain delete after a git removal of the same folder must check its pin first', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-pin-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /review gaps: 0; synthetic source only, never executed/);
});

// Every report prints the folder beside git's line, so a long folder path in
// git's own text must not crowd out the words that say what went wrong.
test('a refusal from a deep folder keeps git\'s reason, not just its path', () => {
  const { base, repo } = landedWorktree();
  try {
    const wt = path.join(base, ...Array.from({ length: 8 }, (_, i) => `nested-folder-level-${i}`), 'deep-wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'deep-run', wt]);
    fs.renameSync(path.join(wt, '.git'), path.join(wt, '.git-moved'));
    const refused = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.ok(refused.stderr.trim().length > 160, refused.stderr);
    const { describeRemovalResult } = require('../commands/worktree');
    const words = "validation failed, cannot remove working tree: 'deep-wt/.git' does not exist";
    assert.equal(describeRemovalResult(wt, refused), words);
    // The same folder named the way os.tmpdir() spells it on macOS.
    assert.equal(describeRemovalResult(wt.replace(/^\/private\//, '/'), refused), words);
    // The reap command prints the same words in its kept line and keeps the folder.
    const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(wt, aged, aged);
    const reaped = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'land', '--reap', '--no-remote', '--base', 'master', '--ttl', '0'], { cwd: repo, encoding: 'utf8' });
    assert.equal(reaped.status, 0, reaped.stderr);
    assert.deepEqual(reaped.stdout.split('\n').filter((line) => line.includes('deep-wt')), [`  ✋ kept, needs a human: ${wt} (${words})`]);
    assert.ok(fs.existsSync(path.join(wt, 'README.md')));
    assert.deepEqual(removalLines(repo).filter((line) => line.path === wt), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a refusal line still too long keeps its start and its end', () => {
  const { describeRefusedRemoval } = require('../commands/worktree');
  const line = `could not remove ${'x'.repeat(300)} because the disk is read-only`;
  const short = describeRefusedRemoval('/nowhere/at/all', `fatal: ${line}\n`);
  assert.ok(short.length <= 160, short);
  assert.ok(short.startsWith('could not remove xxx'), short);
  assert.ok(short.endsWith('because the disk is read-only'), short);
});

// Git accepts line breaks in pin reasons. Every cleanup still owes the
// operator one readable report line, while the stored reason stays intact.
test('multiline pin reasons stay on one line in refusal and real cleanup reports', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const reason = 'reviewer still reading\n  leave this copy\tfor tomorrow';
    git(repo, ['worktree', 'lock', '--reason', reason, wt]);
    const pin = path.join(worktreeGitDir(wt), 'locked');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(pin, stale, stale);
    const words = 'pinned by git worktree lock, 3 h old: reviewer still reading leave this copy for tomorrow';
    const refused = spawnSync('git', ['worktree', 'remove', wt], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    const { describeRefusedRemoval } = require('../commands/worktree');
    assert.equal(describeRefusedRemoval(wt, refused.stderr), words);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/atris.js'), 'worktree', 'cleanup', '--base', 'HEAD', '--apply'], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\n').filter((line) => line.includes('reviewer') || line.includes('tomorrow')), [`held: ${wt} ${words}`]);
    assert.equal(fs.readFileSync(pin, 'utf8').trim(), reason);
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

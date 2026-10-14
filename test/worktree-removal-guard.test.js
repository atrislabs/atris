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
const { reap } = require('../commands/land');
const { cleanupWorktrees } = require('../commands/worktree');
const { disposeReviewSandbox } = require('../lib/fleet');
const { regressionCheck } = require('../commands/autopilot');

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
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'index.lock'), '');
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(fs.existsSync(wt), JSON.stringify(receipt));
    assert.ok(receipt.keptWorktrees.some((line) => line.includes('git_lock')), JSON.stringify(receipt));
    assert.ok(!receipt.deletedBranches.includes('engine-run'));
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

// Shaped like the fleet review sandbox. Its own git dir points at a throwaway
// path so disposal never deletes the fixture repo's .git.
function reviewSandbox() {
  const { base, repo, wt } = landedWorktree();
  const quarantine = path.join(base, 'quarantine.git');
  fs.mkdirSync(quarantine);
  return { base, repo, wt, boundary: { trustedRoot: repo, sandboxRoot: path.join(base, 'sandbox'), worktreePath: wt, gitDir: path.join(base, 'sandbox.git'), quarantine } };
}

test('fleet review cleanup keeps a sandbox while git holds its lock', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'index.lock'), '');
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_lock' });
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.existsSync(boundary.quarantine));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup names who removed a sandbox and why', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
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

// Tripwire: a work folder removal in these files, by git or by a raw delete of
// a worktree path, must sit in a function that also asks the git-activity
// check and writes the removal log. An exception needs a reason here, and a
// stale exception fails too.
const GUARDED_FILES = ['lib/fleet.js', 'commands/land.js', 'commands/autopilot.js', 'commands/worktree.js'];
const UNGUARDED_REMOVALS = {
  'commands/worktree.js:createAgentWorktree': 'drops a folder it just made before any engine entered; plain remove refuses dirt',
  'lib/fleet.js:prepareReviewSandbox': 'wipes its own temp sandbox when setup fails; only that call touched it, so any lock is stale',
};
const WORKTREE_REMOVAL = /worktree['"]?\s*,\s*['"]remove['"]|git worktree remove|rmSync\(\s*[^,)]*(?:worktree|wtPath|\bwt\b|\bw\.path)/i;

function worktreeRemovalSites(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const starts = lines.flatMap((line, index) => {
    const match = line.match(/^(?:async\s+)?function\s+(\w+)/);
    return match ? [{ name: match[1], index }] : [];
  });
  const sites = [];
  lines.forEach((line, index) => {
    if (!WORKTREE_REMOVAL.test(line)) return;
    const owner = starts.filter((start) => start.index <= index).pop();
    const next = starts.find((start) => start.index > index);
    const body = lines.slice(owner ? owner.index : 0, next ? next.index : lines.length).join('\n');
    sites.push({ key: `${file}:${owner ? owner.name : '(top level)'}`, line: index + 1, body });
  });
  return sites;
}

test('every work folder removal goes through the git check and the removal log', () => {
  const sites = GUARDED_FILES.flatMap(worktreeRemovalSites);
  assert.ok(sites.length >= 5, `expected the known removal sites, found ${sites.length}`);
  const bypasses = sites
    .filter((site) => !UNGUARDED_REMOVALS[site.key])
    .filter((site) => !site.body.includes('worktreeGitActivity') || !site.body.includes('recordWorktreeRemoval'))
    .map((site) => `${site.key} (line ${site.line})`);
  assert.deepEqual(bypasses, [], 'removal without the git check or the removal log');
  const stale = Object.keys(UNGUARDED_REMOVALS).filter((key) => !sites.some((site) => site.key === key));
  assert.deepEqual(stale, [], 'exception names a function that no longer removes a folder');
});

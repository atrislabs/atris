'use strict';

// Engine work folders are never removed while a run is inside them, and every
// removal leaves one line saying who removed it and why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { reap } = require('../commands/land');
const { cleanupWorktrees } = require('../commands/worktree');
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

function regressionEntry(repo, verifyCmd) {
  const hash = git(repo, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'atris', 'tick-registry.json'), JSON.stringify([{ hash, verifyCmd, slug: 'folder-cleanup' }]));
  return path.join(repo, '.regression-worktree-' + hash.slice(0, 8));
}

test('regression cleanup keeps old private and shared git locks created by the real check', () => {
  const { base, repo } = landedWorktree();
  try {
    const source = String.raw`const fs = require('fs'); const path = require('path');
      const { execFileSync } = require('child_process');
      const roots = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8' }).trim().split('\n');
      for (const file of [path.join(roots[0], 'index.lock'), path.join(roots[1], 'refs/heads/master.lock')]) {
        fs.writeFileSync(file, 'unfinished git work');
        const aged = new Date(Date.now() - 7200000); fs.utimesSync(file, aged, aged);
      }`;
    const folder = regressionEntry(repo, `node -e '${source.replace(/'/g, "'\\''")}'`);
    const [result] = regressionCheck(repo);
    assert.equal(result.pass, true);
    assert.equal(result.cleanup.removed, false);
    const privateDir = git(folder, ['rev-parse', '--absolute-git-dir']);
    for (const file of [path.join(privateDir, 'index.lock'), path.join(repo, '.git', 'refs/heads/master.lock')]) {
      assert.ok(fs.existsSync(file));
      assert.ok(result.cleanup.reason.includes(`${file} (`), result.cleanup.reason);
    }
    assert.match(result.cleanup.reason, /\(720\d+s old\)/);
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('regression cleanup logs successful removal and leaves a pre-existing folder alone', () => {
  const { base, repo } = landedWorktree();
  try {
    const folder = regressionEntry(repo, 'node -e "process.exit(0)"');
    const [result] = regressionCheck(repo);
    assert.equal(result.pass, true);
    assert.equal(result.cleanup.removed, true);
    assert.equal(fs.existsSync(folder), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, folder);
    assert.equal(line.by, 'atris autopilot');
    assert.equal(line.reason, 'regression_check_finished');
    git(repo, ['worktree', 'add', '-q', '--detach', folder, 'HEAD']);
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'unfinished work');
    const [skipped] = regressionCheck(repo);
    assert.equal(skipped.skipped, true);
    assert.equal(fs.readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'unfinished work');
    assert.equal(removalLines(repo).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

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

test('reap keeps old private and shared git locks in preview and forced removal', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const privateDir = git(wt, ['rev-parse', '--absolute-git-dir']);
    const locks = [path.join(privateDir, 'index.lock'), path.join(repo, '.git', 'refs', 'heads', 'master.lock')];
    const now = Date.now();
    const aged = new Date(now - 7200000);
    for (const lock of locks) {
      fs.writeFileSync(lock, 'unfinished git work\n');
      fs.utimesSync(lock, aged, aged);
    }
    for (const dryRun of [true, false]) {
      const receipt = reap(repo, { remote: false, force: true, dryRun, now, activeCwds: [] });
      assert.deepEqual(receipt.removedWorktrees, []);
      assert.deepEqual(receipt.deletedBranches, []);
      for (const lock of locks) {
        assert.ok(receipt.keptWorktrees.some((line) => line.includes(`${lock} (7200s old)`)), JSON.stringify(receipt));
        assert.ok(fs.existsSync(lock));
      }
      assert.ok(fs.existsSync(wt));
      assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/engine-run']), git(repo, ['rev-parse', 'HEAD']));
      assert.deepEqual(removalLines(repo), []);
      assert.equal(receipt.bundle, null);
      assert.deepEqual(receipt.patches, []);
    }
  } finally {
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

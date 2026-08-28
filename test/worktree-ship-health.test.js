'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const close = require('../commands/close');
const { runShipHealthCheck } = require('../commands/worktree');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const NOW = '2026-08-28T12:00:00.000Z';
const HEALTH_LINE = 'health check failed: no verified experiment in 3 days. shipping still works, the metabolism does not.';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-worktree-ship-health-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeState(dir, value) {
  const file = path.join(dir, '.atris', 'state', 'experiments-daily.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function capture(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), stdout: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

function addOpenLoop(dir, index) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return close.run(['add', `existing loop ${index}`], { cwd: dir, now: NOW });
  } finally {
    console.log = originalLog;
  }
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('stale experiment state warns and refreshes one probed close loop', () => {
  const dir = makeTempDir();
  try {
    writeState(dir, { last_run_date: '2026-08-25' });
    const first = capture(() => runShipHealthCheck(dir, { now: NOW }));
    assert.equal(first.stdout, HEALTH_LINE);
    assert.equal(first.result.filed, true);
    assert.equal(first.result.refreshed, false);

    let flags = close.openFlags(dir, { now: NOW });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].source, 'ship-health:experiments-daily');
    assert.ok(flags[0].probe);
    assert.notEqual(spawnSync(flags[0].probe, { cwd: dir, shell: true }).status, 0);

    const secondNow = '2026-08-28T13:00:00.000Z';
    const second = capture(() => runShipHealthCheck(dir, { now: secondNow }));
    assert.equal(second.result.refreshed, true);
    flags = close.openFlags(dir, { now: secondNow });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].opened_at, secondNow);

    writeState(dir, { last_run_date: new Date().toISOString().slice(0, 10) });
    assert.equal(spawnSync(flags[0].probe, { cwd: dir, shell: true }).status, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('fresh experiment state stays quiet and files nothing', () => {
  const dir = makeTempDir();
  try {
    writeState(dir, { last_run_date: '2026-08-28' });
    const checked = capture(() => runShipHealthCheck(dir, { now: NOW }));
    assert.equal(checked.stdout, '');
    assert.equal(checked.result.healthy, true);
    assert.equal(close.openFlags(dir, { now: NOW }).length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a full ten-slot queue still warns without filing a loop', () => {
  const dir = makeTempDir();
  try {
    writeState(dir, { last_run_date: '2026-08-25' });
    for (let index = 0; index < 10; index += 1) {
      assert.equal(addOpenLoop(dir, index), 0);
    }

    const checked = capture(() => runShipHealthCheck(dir, { now: NOW }));
    assert.equal(checked.stdout, HEALTH_LINE);
    assert.equal(checked.result.filed, false);
    const flags = close.openFlags(dir, { now: NOW });
    assert.equal(flags.length, 10);
    assert.equal(flags.some((flag) => flag.source === 'ship-health:experiments-daily'), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('corrupted experiment state reports one note without breaking a merged ship', () => {
  const dir = makeTempDir();
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'ship-worktree');
  try {
    fs.mkdirSync(repo);
    runGit(['init', '-q'], repo);
    runGit(['config', 'user.email', 'test@example.com'], repo);
    runGit(['config', 'user.name', 'Test User'], repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# health check\n');
    runGit(['add', '.'], repo);
    runGit(['commit', '-qm', 'initial'], repo);
    runGit(['branch', '-M', 'master'], repo);
    runGit(['worktree', 'add', '-qb', 'ship-health-test', worktree, 'master'], repo);
    fs.appendFileSync(path.join(worktree, 'README.md'), 'shipped\n');
    writeState(repo, '{not json');

    const shipped = spawnSync(process.execPath, [
      cliPath,
      'worktree',
      'ship',
      '--message',
      'ship health test',
      '--verify',
      'git status --short',
      '--merge',
      '--local',
      '--target',
      'master',
    ], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });

    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /merge: merged \(local mode\)/);
    assert.match(shipped.stdout, /health check skipped: .+ shipping still works\./);
    assert.match(shipped.stdout, /done: worktree shipped/);
  } finally {
    cleanupTempDir(dir);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { acquireRunLock, lockPath } = require('../lib/campaign-run-lock');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('one run holds the lock; a second is refused until the first releases it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = acquireRunLock(home, 'cmp-a', { pid: 101, isAlive: () => true });
  assert.equal(first.ok, true);
  const second = acquireRunLock(home, 'cmp-a', { pid: 202, isAlive: () => true });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, 101);
  assert.equal(acquireRunLock(home, 'cmp-b', { pid: 202, isAlive: () => true }).ok, true, 'other campaigns are not blocked');
  first.release();
  assert.equal(fs.existsSync(lockPath(home, 'cmp-a')), false);
  assert.equal(acquireRunLock(home, 'cmp-a', { pid: 202, isAlive: () => true }).ok, true);
});

test('a lock whose process is gone is taken over, and release never removes someone else\'s lock', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stale = acquireRunLock(home, 'cmp-a', { pid: 101, isAlive: () => true });
  const taken = acquireRunLock(home, 'cmp-a', { pid: 202, isAlive: (pid) => pid !== 101 });
  assert.equal(taken.ok, true);
  stale.release();
  assert.equal(JSON.parse(fs.readFileSync(lockPath(home, 'cmp-a'), 'utf8')).pid, 202);
});

test('campaign step refuses while a live process drives the same campaign', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-lock-cli-'));
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => {
    sleeper.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, '.git'));
  const state = path.join(dir, 'state');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(state, 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(cli('start', 'Lock test', '--judge', 'exit 1', '--id', 'cmp-lock').status, 0);
  const file = lockPath(state, 'cmp-lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ pid: sleeper.pid, host: os.hostname(), cwd: '/elsewhere', started_at: '2026-10-15T00:00:00Z' })}\n`);
  const refused = cli('step', 'cmp-lock');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`another run is driving cmp-lock \\(pid ${sleeper.pid} in /elsewhere`));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, sleeper.pid, 'the holder keeps its lock');
});

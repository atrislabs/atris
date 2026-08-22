'use strict';

// Regression: on 2026-08-21, 49 bug tasks sat falsely "in progress" because
// flights claimed them before dispatch, the engines were guard-blocked and did
// nothing, and the pause path never handed the claims back. After landing, a
// paused task whose worktree carries no commits past base and only conductor
// litter must have its claim released; a paused task WITH real work keeps the
// claim so takeover stays attributed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { releasePausedClaimsWithoutWork } = require('../lib/fleet');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepoPair(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  return dir;
}

test('a paused worktree with only conductor litter releases its claim', (t) => {
  const wt = makeRepoPair(t);
  fs.mkdirSync(path.join(wt, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.atris', 'fleet-prompt-BCK-1.md'), 'prompt');
  fs.writeFileSync(path.join(wt, '.atris', 'codex-watchdog.js'), '// plumbing');

  const calls = [];
  const cli = (args) => { calls.push(args); return { status: 0 }; };
  const paused = [{ task: 'BCK-1', stage: 'ship', worktree: wt }];
  releasePausedClaimsWithoutWork(cli, {
    paused,
    worktreeByTask: new Map(),
    actorByTask: new Map([['BCK-1', 'fleet-codex']]),
    baseRef: 'HEAD',
  });
  assert.deepEqual(calls, [['task', 'release', 'BCK-1', '--as', 'fleet-codex']]);
  assert.equal(paused[0].claim_released, true);
});

test('a paused worktree with a real commit keeps its claim', (t) => {
  const wt = makeRepoPair(t);
  git(wt, 'tag', 'base');
  fs.writeFileSync(path.join(wt, 'fix.py'), 'x = 1\n');
  git(wt, 'add', 'fix.py');
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'real work');

  const calls = [];
  const cli = (args) => { calls.push(args); return { status: 0 }; };
  const paused = [{ task: 'BCK-2', stage: 'ship', worktree: wt }];
  releasePausedClaimsWithoutWork(cli, {
    paused,
    worktreeByTask: new Map(),
    actorByTask: new Map([['BCK-2', 'fleet-codex']]),
    baseRef: 'base',
  });
  assert.deepEqual(calls, []);
  assert.equal(paused[0].claim_released, undefined);
});

test('uncommitted real edits also keep the claim', (t) => {
  const wt = makeRepoPair(t);
  fs.writeFileSync(path.join(wt, 'wip.py'), 'x = 1\n');

  const calls = [];
  const cli = (args) => { calls.push(args); return { status: 0 }; };
  releasePausedClaimsWithoutWork(cli, {
    paused: [{ task: 'BCK-3', stage: 'verify_failed', worktree: wt }],
    worktreeByTask: new Map(),
    actorByTask: new Map([['BCK-3', 'fleet-cursor']]),
    baseRef: 'HEAD',
  });
  assert.deepEqual(calls, []);
});

test('claim-stage pauses and already-released rows are skipped', () => {
  const calls = [];
  const cli = (args) => { calls.push(args); return { status: 0 }; };
  releasePausedClaimsWithoutWork(cli, {
    paused: [
      { task: 'BCK-4', stage: 'claim' },
      { task: 'BCK-5', stage: 'worktree_start', claim_released: true },
    ],
    worktreeByTask: new Map(),
    actorByTask: new Map([['BCK-4', 'fleet-codex'], ['BCK-5', 'fleet-codex']]),
  });
  assert.deepEqual(calls, []);
});

test('a worktree_start pause with no worktree releases the held claim', () => {
  const calls = [];
  const cli = (args) => { calls.push(args); return { status: 0 }; };
  const paused = [{ task: 'BCK-6', stage: 'worktree_start', detail: 'boom' }];
  releasePausedClaimsWithoutWork(cli, {
    paused,
    worktreeByTask: new Map(),
    actorByTask: new Map([['BCK-6', 'fleet-grok']]),
  });
  assert.deepEqual(calls, [['task', 'release', 'BCK-6', '--as', 'fleet-grok']]);
  assert.equal(paused[0].claim_released, true);
});

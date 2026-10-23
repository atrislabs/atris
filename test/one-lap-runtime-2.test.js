'use strict';

let test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ASK, LAP_TEST_TIMEOUT_MS, cliPath, run, git, cli, cliAsync, waitForFile,
  json, setupRuntime, cleanupRuntime, assertMasterUnchanged,
} = require('./helpers/one-lap-runtime');

if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) test = test.skip;

test('one lap OS boundary blocks a passing verifier from pushing protected master', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('verifier-escape');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'verifier escape one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap proof binding blocks a partially materialized landing from ship', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('pass');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'partial landing one lap');
    setup.worktrees.push(payload.worktree);
    fs.rmSync(path.join(payload.worktree, 'lap-marker.txt'));
    const shipped = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--message', 'ship partial one lap',
      '--verify', 'node --test',
      '--local',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipped.status, 3, shipped.stderr || shipped.stdout);
    // Which check catches it depends on what else is left in the folder: an
    // untracked file the lap left, once deleted, leaves nothing to commit, so
    // the HEAD check blocks it instead of the index check. Either way it stops.
    assert.match(shipped.stderr, /one-lap (?:index|head) tree differs from the independently verified proof tree/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap rejects case-variant reserved metadata symlinks', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('reserved-symlink');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'reserved symlink one lap');
    setup.worktrees.push(payload.worktree);
    assert.match(payload.reason, /conflicts with Atris worktree metadata|unsafe path/i);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap keeps proof out of Review when the independent validator rejects', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('validator-reject');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'validator rejection');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.equal(payload.checked, 'node --test passed (exit 0)');
    assert.match(payload.reason, /does not satisfy the task/);
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'validator rejected task');
    assert.equal(task.status, 'claimed');
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.verifier_result.passed, true);
    assert.equal(receipt.result.validator_result.passed, false);
    assert.equal(receipt.result.validator_result.verdict, 'reject');
    assert.equal(receipt.ready.length, 0);
    assert.equal(receipt.paused[0].stage, 'validation_rejected');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

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

test('one lap keeps the worktree and proof receipt when the real verifier fails', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('fail');
  try {
    const worktreesBefore = git(['worktree', 'list', '--porcelain'], setup.workspace, setup.env)
      .split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    const engineTrace = fs.existsSync(setup.env.ATRIS_ENGINE_PROMPT)
      ? fs.readFileSync(setup.env.ATRIS_ENGINE_PROMPT, 'utf8')
      : '(no engine trace)';
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nengine:\n${engineTrace}`);
    const payload = json(result, 'one lap failure');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.ok, false);
    assert.equal(payload.checked, 'node --test failed (exit 1)');
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);
    assert.ok(fs.existsSync(payload.worktree), 'failed worktree must remain available');
    const worktreesAfter = git(['worktree', 'list', '--porcelain'], setup.workspace, setup.env)
      .split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length;
    assert.equal(worktreesAfter, worktreesBefore, 'failed lap must not leak a hidden protected-origin worktree');

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'failed one lap task');
    assert.notEqual(task.status, 'review');
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.verifier_result.command, 'node --test');
    assert.equal(receipt.result.verifier_result.status, 1);
    assert.match(receipt.result.verifier_result.output, /ENOENT|lap-marker\.txt/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '', 'validator must not run after verifier failure');
    assertMasterUnchanged(setup);

    const downgraded = cli([ASK, '--engine', 'codex', '--verify', 'git diff --check', '--json'], setup);
    assert.equal(downgraded.status, 2, downgraded.stderr || downgraded.stdout);
    assert.match(json(downgraded, 'frozen verifier retry').reason, /verifier is frozen/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    const stillClaimed = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'frozen verifier task');
    assert.equal(stillClaimed.status, 'claimed');

    setup.env.ATRIS_ENGINE_MODE = 'pass';
    const resumed = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(resumed.status, 0, `stdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    const resumedPayload = json(resumed, 'resumed failed one lap');
    assert.equal(resumedPayload.status, 'done');
    assert.equal(resumedPayload.task_id, payload.task_id);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '2');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    setup.worktrees.push(resumedPayload.worktree);
    const resumedTask = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'resumed one lap task');
    assert.equal(resumedTask.status, 'review');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap ignores a worker-forged quarantine deletion sidecar', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('forge-sidecar');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'forged sidecar one lap');
    setup.worktrees.push(payload.worktree);
    const sidecar = JSON.parse(fs.readFileSync(path.join(payload.worktree, '.atris', 'agent-worktree.json'), 'utf8'));
    assert.equal(sidecar.one_lap_remote, undefined);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], payload.worktree, setup.env), 'true');
    assert.equal(path.resolve(git(['remote', 'get-url', '--push', 'origin'], payload.worktree, setup.env)), path.resolve(setup.origin));
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap rejects Unicode paths that alias reserved metadata on APFS', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('unicode-reserved-symlink');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(json(result, 'unicode reserved symlink one lap').reason, /non-ASCII path|could not be imported safely/i);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap blocks validator git metadata mutations before Review', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('validator-mutate');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'validator metadata mutation');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.match(payload.reason, /validator changed the worktree|Operation not permitted/i);
    setup.worktrees.push(payload.worktree);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.result.passed, false);
    assert.equal(receipt.result.validator_result.worktree_unchanged, true);
    assert.equal(receipt.paused[0].stage, 'validator_failed');
    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'mutated validator task');
    assert.equal(task.status, 'claimed');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

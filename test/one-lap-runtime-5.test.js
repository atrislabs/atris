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

test('one lap honors trusted operator Git URL rewrites for protected remote access', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('pass');
  try {
    git(['config', '--global', `url.${setup.origin}.insteadOf`, 'one-lap://protected/'], setup.workspace, setup.env);
    git(['remote', 'set-url', 'origin', 'one-lap://protected/'], setup.workspace, setup.env);
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'rewritten remote one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(payload.status, 'done');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('identical asks in separate processes run one atomic lap', { timeout: LAP_TEST_TIMEOUT_MS }, async () => {
  const setup = setupRuntime('pass');
  try {
    setup.env.ATRIS_ENGINE_DELAY = '5';
    const firstRun = cliAsync([ASK, '--engine', 'codex', '--json'], setup);
    await waitForFile(setup.env.ATRIS_ENGINE_PROMPT);

    const concurrent = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout);
    const concurrentPayload = json(concurrent, 'concurrent one lap');
    assert.ok(['waiting_input', 'done'].includes(concurrentPayload.status));
    if (concurrentPayload.status === 'waiting_input') {
      assert.equal(concurrentPayload.question, 'an identical lap is already running');
    }
    assert.equal(concurrentPayload.resumed, true);

    const first = await firstRun;
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    const firstPayload = json(first, 'first atomic one lap');
    assert.equal(firstPayload.status, 'done');
    setup.worktrees.push(firstPayload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');

    const events = fs.readFileSync(path.join(setup.workspace, '.atris', 'state', 'wishes.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const capturedIds = new Set(events
      .filter((event) => event.text === ASK && event.status === 'captured')
      .map((event) => event.id));
    assert.equal(capturedIds.size, 1, 'one ask lease must create one durable wish');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap blocks an engine git push before recording Review', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('push');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'push-blocked one lap');
    assert.equal(payload.status, 'stuck');
    assert.equal(payload.validator, 'claude');
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'pushed');
    assert.notEqual(path.resolve(fs.readFileSync(setup.env.ATRIS_PUSH_URL, 'utf8').trim()), path.resolve(setup.origin));
    assert.match(payload.reason, /quarantined remote/);
    assert.ok(payload.worktree);
    setup.worktrees.push(payload.worktree);
    assertMasterUnchanged(setup);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.ready.length, 0);
    assert.equal(receipt.paused[0].stage, 'outbound_attempt');
    assert.equal(receipt.paused[0].master_before, setup.masterBefore);
    assert.equal(receipt.paused[0].master_after, setup.masterBefore);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reaps detached engine children before proof advances', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('late-mutate');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'reaped child one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(payload.status, 'done');
    assert.equal(fs.existsSync(path.join(payload.worktree, 'late.txt')), false);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('a real isolated review on main preserves the protected branch and imports the verified build', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('pass', 'main');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = json(result, 'main branch review');
    setup.worktrees.push(payload.worktree);
    assert.equal(payload.result.passed, true);
    assert.equal(fs.readFileSync(path.join(payload.worktree, 'lap-marker.txt'), 'utf8'), 'one lap\n');
    assert.equal(json(cli(['task', 'show', payload.task_id, '--json'], setup), 'review task').status, 'review');
    assertMasterUnchanged(setup);
    const prompt = fs.readFileSync(setup.env.ATRIS_VALIDATOR_PROMPT, 'utf8');
    assert.ok(prompt.includes(`git diff ${setup.masterBefore}...HEAD`), prompt);
  } finally {
    cleanupRuntime(setup);
  }
});

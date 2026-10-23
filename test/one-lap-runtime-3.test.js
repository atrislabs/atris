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

test('one lap freezes the repo default verifier before dispatch', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('pass');
  try {
    fs.rmSync(path.join(setup.workspace, 'test'), { recursive: true, force: true });
    git(['add', '-A'], setup.workspace, setup.env);
    git(['commit', '-m', 'remove project verifier for retry test'], setup.workspace, setup.env);
    git(['push', 'origin', 'master'], setup.workspace, setup.env);
    setup.masterBefore = git(['rev-parse', 'origin/master'], setup.workspace, setup.env);

    const initial = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    const payload = json(initial, 'one lap default verifier');
    assert.equal(payload.status, 'done');
    assert.equal(payload.verifier, 'git diff --check');
    setup.worktrees.push(payload.worktree);

    const missions = fs.readFileSync(path.join(setup.workspace, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const frozen = missions.filter((row) => row.id === payload.mission_id).at(-1);
    assert.equal(frozen.verifier, 'git diff --check');

    const replaced = cli([ASK, '--engine', 'codex', '--verify', 'node --check missing.js', '--json'], setup);
    assert.equal(replaced.status, 2, replaced.stderr || replaced.stdout);
    assert.match(json(replaced, 'replaced retry verifier').reason, /verifier is frozen/);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap omits protected repository locators from the executor boundary', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('inspect-boundary');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'boundary inspection one lap');
    setup.worktrees.push(payload.worktree);
    const dump = fs.readFileSync(setup.env.ATRIS_BOUNDARY_DUMP, 'utf8');
    assert.ok(!dump.includes(setup.workspace), 'executor boundary must not reveal the primary checkout');
    assert.ok(!dump.includes(setup.origin), 'executor boundary must not reveal the protected remote');
    assert.ok(!dump.includes(payload.worktree), 'executor boundary must not reveal the untouched landing worktree');
    assert.match(dump, /\/quarantine\.git/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap raw tree import never executes worker-controlled Git filters', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('smudge-filter');
  try {
    git(['config', 'filter.escape.clean', "sed 's/one/escaped/g'"], setup.workspace, setup.env);
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'smudge filter one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assert.equal(fs.readFileSync(path.join(payload.worktree, '.gitattributes'), 'utf8'), '*.txt filter=escape\n');
    const shipped = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--message', 'ship filter-bound one lap',
      '--verify', 'node --test',
      '--local',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipped.status, 3, shipped.stderr || shipped.stdout);
    assert.match(shipped.stderr, /one-lap index tree differs from the independently verified proof tree/);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap cleanup survives an engine killing its sandbox group leader', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('kill-lifecycle');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'killed lifecycle one lap');
    if (payload.worktree) setup.worktrees.push(payload.worktree);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reports the engine that actually completed a restaffed build', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('restaff');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'restaffed one lap');
    assert.equal(payload.engine, 'cursor');
    assert.equal(payload.validator, 'claude');
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '2');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    setup.worktrees.push(payload.worktree);
    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.ready[0].engine, 'cursor');
    assert.deepEqual(receipt.ready[0].restaffed, {
      from: 'codex',
      to: 'cursor',
      reason: 'usage_limit',
      failed_legs: [{ engine: 'codex', exitCode: 1, stderr: 'usage limit reached\n', report: '' }],
    });

    const repeated = json(cli([ASK, '--json'], setup), 'resumed restaffed one lap');
    assert.equal(repeated.engine, 'cursor');
  } finally {
    cleanupRuntime(setup);
  }
});

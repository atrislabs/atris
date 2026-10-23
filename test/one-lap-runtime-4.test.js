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

test('one natural sentence runs one real isolated lap to verified Review without merging master', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('pass');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'one lap success');
    assert.equal(payload.schema, 'atris.one_lap.v1');
    assert.equal(payload.status, 'done');
    assert.equal(payload.ok, true);
    assert.equal(payload.engine, 'codex');
    assert.equal(payload.validator, 'claude');
    assert.equal(payload.verifier, 'node --test');
    assert.equal(payload.mission_status, 'ready');
    assert.equal(payload.approval_status, 'pending');
    assert.equal(payload.master_changed, false);
    assert.equal(payload.result.passed, true);
    assert.match(result.stderr, /navigator is scoping the request/);
    assert.match(result.stderr, /codex is building/);
    assert.doesNotMatch(result.stderr, /[—–✓✔✗✖⏸·→]/);
    assert.doesNotMatch(result.stdout, /CONTEXT LOADED|DIRECT REQUEST/);
    setup.worktrees.push(payload.worktree);

    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1');
    const prompt = fs.readFileSync(setup.env.ATRIS_ENGINE_PROMPT, 'utf8');
    assert.match(prompt, new RegExp(ASK));
    assert.match(prompt, /Trusted verifier.*node --test/);
    const validatorPrompt = fs.readFileSync(setup.env.ATRIS_VALIDATOR_PROMPT, 'utf8');
    assert.match(validatorPrompt, /independent validator/);
    assert.match(validatorPrompt, /Required verifier: node --test/);
    assert.match(validatorPrompt, /--allowedTools Bash,Read,Grep,Glob/);
    assert.equal(fs.readFileSync(path.join(payload.worktree, 'lap-marker.txt'), 'utf8'), 'one lap\n');
    const verified = run(process.execPath, ['--test'], { cwd: payload.worktree, env: setup.env });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);

    const task = json(cli(['task', 'show', payload.task_id, '--json'], setup), 'one lap task');
    assert.equal(task.status, 'review');
    assert.equal(task.review.approval_status, 'pending');
    const sentinel = json(cli(['task', 'show', setup.sentinel, '--json'], setup), 'sentinel');
    assert.equal(sentinel.status, 'open');

    const receipt = JSON.parse(fs.readFileSync(path.join(setup.workspace, payload.receipt), 'utf8'));
    assert.equal(receipt.schema, 'atris.dispatch_receipt.v1');
    assert.equal(receipt.context.ask, ASK);
    assert.equal(receipt.context.wish_id, payload.wish_id);
    assert.equal(receipt.context.mission_id, payload.mission_id);
    assert.equal(receipt.result.passed, true);
    assert.equal(receipt.result.verifier_result.command, 'node --test');
    assert.equal(receipt.result.verifier_result.status, 0);
    assert.match(receipt.result.verifier_result.output, /pass 1/);
    assert.equal(git(['cat-file', '-t', receipt.ready[0].change.source_commit], payload.worktree, setup.env), 'commit');
    assert.equal(git(['rev-parse', receipt.ready[0].change.proof_ref], payload.worktree, setup.env), receipt.ready[0].change.source_commit);
    assert.deepEqual({
      engine: receipt.result.validator_result.engine,
      executor_engine: receipt.result.validator_result.executor_engine,
      independent: receipt.result.validator_result.independent,
      passed: receipt.result.validator_result.passed,
      verdict: receipt.result.validator_result.verdict,
      worktree_unchanged: receipt.result.validator_result.worktree_unchanged,
    }, {
      engine: 'claude',
      executor_engine: 'codex',
      independent: true,
      passed: true,
      verdict: 'signoff',
      worktree_unchanged: true,
    });
    assertMasterUnchanged(setup);
    assert.equal(path.resolve(git(['remote', 'get-url', '--push', 'origin'], payload.worktree, setup.env)), path.resolve(setup.origin));
    const sidecar = JSON.parse(fs.readFileSync(path.join(payload.worktree, '.atris', 'agent-worktree.json'), 'utf8'));
    assert.equal(sidecar.one_lap_remote, undefined);
    const shipPreview = run(process.execPath, [
      cliPath,
      'worktree', 'ship',
      '--dry-run',
      '--message', 'ship verified one lap',
      '--target', 'origin/master',
    ], { cwd: payload.worktree, env: setup.env });
    assert.equal(shipPreview.status, 0, shipPreview.stderr || shipPreview.stdout);
    assert.match(shipPreview.stdout, /done: worktree shipped/);

    const repeated = cli([ASK, '--engine=codex', '--json'], setup);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.equal(json(repeated, 'resumed one lap').resumed, true);
    assert.equal(fs.readFileSync(setup.env.ATRIS_ENGINE_COUNT, 'utf8').trim(), '1', 'duplicate ask must not run another engine');
    assert.equal(fs.readFileSync(setup.env.ATRIS_VALIDATOR_COUNT, 'utf8').trim(), '1', 'duplicate ask must not run another validator');

    const textResult = cli([ASK], setup);
    assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
    assert.match(textResult.stdout, /^lap: done$/m);
    assert.match(textResult.stdout, /^changed:/m);
    assert.match(textResult.stdout, /^how i checked: node --test passed$/m);
    assert.match(textResult.stdout, /^proof: atris\/runs\/dispatch-/m);
    assert.match(textResult.stdout, /^next: cd .+atris worktree ship /m);
    assert.doesNotMatch(textResult.stdout, /CONTEXT LOADED|DIRECT REQUEST|[—–✓✔✗✖⏸·→]/);

    fs.unlinkSync(path.join(setup.workspace, payload.receipt));
    const missingProof = cli([ASK, '--json'], setup);
    assert.equal(missingProof.status, 1, missingProof.stderr || missingProof.stdout);
    const missingPayload = json(missingProof, 'missing one-lap proof');
    assert.equal(missingPayload.status, 'stuck');
    assert.match(missingPayload.reason, /without a passing matching one-lap receipt/);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap OS boundary blocks an executor that knows the protected checkout path', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('escape-primary');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'executor escape one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap gives engines an ephemeral home and cannot persist agent config', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('persist-home');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'ephemeral home one lap');
    setup.worktrees.push(payload.worktree);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), 'blocked');
    assert.equal(fs.readFileSync(path.join(setup.home || path.join(setup.base, 'home'), '.codex', 'session-secret.txt'), 'utf8'), 'do not expose\n');
    assert.equal(fs.existsSync(path.join(setup.base, 'home', '.codex', 'config-injected.toml')), false);
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

test('one lap reaps a detached child that creates a new session', { timeout: LAP_TEST_TIMEOUT_MS }, () => {
  const setup = setupRuntime('session-escape');
  try {
    const result = cli([ASK, '--engine', 'codex', '--json'], setup);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = json(result, 'new-session child one lap');
    setup.worktrees.push(payload.worktree);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    assert.equal(fs.readFileSync(setup.env.ATRIS_PUSH_RESULT, 'utf8').trim(), '');
    assertMasterUnchanged(setup);
  } finally {
    cleanupRuntime(setup);
  }
});

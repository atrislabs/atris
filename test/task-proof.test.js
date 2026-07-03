const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { taskProofLooksMeaningful, taskProofLooksExecuted, taskProofState, taskProofExecutionState, buildVerifiedProof } = require('../lib/task-proof');
const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-proof-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    encoding: 'utf8',
  });
}

function certifiedReviewTaskWithProof(proof) {
  return {
    id: 'task-1',
    display_id: 'CLI-843',
    status: 'review',
    tag: 'code',
    workspace_root: process.cwd(),
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: proof,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof,
    },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  };
}

test('task proof helper rejects generic or vague completion proof', () => {
  for (const proof of ['', 'done', 'ok', 'looks good', 'I finished the implementation and checked it', 'Proof: done', 'Archived from Tasks focus by human: Raw task']) {
    assert.equal(taskProofLooksMeaningful(proof), false, `${JSON.stringify(proof)} should be rejected`);
  }
  assert.match(taskProofState('I finished the implementation and checked it').reason, /concrete evidence/);
});

test('task proof helper accepts commands, verifier results, receipts, and human approval', () => {
  for (const proof of [
    'npm run test passed',
    'node --test test/commands.test.js passed',
    'node bin/atris.js clean --dry-run --json passed',
    'typecheck passed and git diff --check passed',
    "grep -qE 'pass|ok' atris/runs/run.json passed",
    "rg -n 'taskProofState' lib/task-proof.js passed",
    "rg -q 'taskProofState' lib/task-proof.js passed",
    'git diff --exit-code -- lib/task-proof.js passed',
    'diff --brief expected.txt actual.txt passed',
    'cmp -s expected.txt actual.txt passed',
    'Receipt saved at atris/runs/proof.json',
    'Human approved: reviewed by keshavrao',
  ]) {
    assert.equal(taskProofLooksMeaningful(proof), true, `${JSON.stringify(proof)} should be accepted`);
  }
  assert.equal(taskProofLooksMeaningful('node bin/atris.js clean --json passed'), false);
});

test('non-strict auto-accept rejects free-text test-passed claims until proof was executed', () => {
  const claimed = 'node --test test/task-proof.test.js passed';
  assert.equal(taskProofLooksMeaningful(claimed), true);
  assert.equal(taskProofLooksExecuted(claimed), false);
  assert.equal(taskProofExecutionState(claimed).reason, 'proof_not_executed');

  const blocked = evaluateAutoAccept(certifiedReviewTaskWithProof(claimed), { strictVerify: false });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'proof_not_executed');
  assert.match(blocked.next_action, /ready --verify/);

  const executed = buildVerifiedProof('node --test test/task-proof.test.js', 'regression covered', () => ({
    status: 0,
    stdout: 'ok 1\n',
    stderr: '',
  })).proof;
  assert.equal(taskProofLooksExecuted(executed), true);

  const accepted = evaluateAutoAccept(certifiedReviewTaskWithProof(executed), { strictVerify: false });
  assert.equal(accepted.eligible, true);
  assert.equal(accepted.reason, 'certified_multi_actor');
  assert.equal(accepted.policy, '2_actors_2_passes');
});

test('buildVerifiedProof turns a passing command into executed proof', () => {
  const calls = [];
  const result = buildVerifiedProof('npm test', 'fixed the parser', (cmd, args, opts) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: 'ok 42 passed\n', stderr: '' };
  });
  assert.equal(result.ok, true);
  assert.equal(result.exit, 0);
  assert.match(result.proof, /^\[verified\] `npm test` passed \(exit 0\)/);
  assert.match(result.proof, /fixed the parser/);
  // The synthesized proof must itself satisfy the proof gate.
  assert.equal(taskProofLooksMeaningful(result.proof), true);
  // It actually ran the command via bash.
  assert.deepEqual(calls[0][0], 'bash');
  assert.deepEqual(calls[0][1], ['-lc', 'npm test']);
});

test('buildVerifiedProof refuses to vouch for a failing or empty command', () => {
  const failing = buildVerifiedProof('npm test', '', () => ({ status: 1, stdout: '', stderr: '3 failing\n' }));
  assert.equal(failing.ok, false);
  assert.equal(failing.reason, 'verifier_failed');
  assert.equal(failing.exit, 1);

  const empty = buildVerifiedProof('', 'note', () => ({ status: 0 }));
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'verify_command_required');
});

test('task ready --verify runs the command and gates on its exit code', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    // Failing verifier must block ready (no --proof escape hatch was given).
    const failAdd = runCli(['task', 'add', 'Verify must run', '--json'], { cwd: dir, env });
    assert.equal(failAdd.status, 0, failAdd.stderr);
    const failRef = JSON.parse(failAdd.stdout).task.display_id;
    const failReady = runCli(['task', 'ready', failRef, '--verify', 'exit 3'], { cwd: dir, env });
    assert.equal(failReady.status, 1);
    assert.match(failReady.stderr, /verifier failed/);

    // Passing verifier marks ready with executed proof.
    const okReady = runCli(['task', 'ready', failRef, '--verify', 'true', '--json'], { cwd: dir, env });
    assert.equal(okReady.status, 0, okReady.stderr);
    const okTask = JSON.parse(okReady.stdout).task;
    assert.match(okTask.review.proof, /\[verified\] `true` passed \(exit 0\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task CLI blocks weak ready proof, positive reviews without proof, and bare done', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Proof gate task', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const bareDoneAdd = runCli(['task', 'add', 'Bare done must not pass', '--json'], { cwd: dir, env });
    assert.equal(bareDoneAdd.status, 0, bareDoneAdd.stderr);
    const bareDoneRef = JSON.parse(bareDoneAdd.stdout).task.display_id;
    const bareDone = runCli(['task', 'done', bareDoneRef, '--json'], { cwd: dir, env });
    assert.equal(bareDone.status, 2);
    assert.match(bareDone.stdout, /weak_proof/);

    const strongDone = runCli(['task', 'done', bareDoneRef, '--proof', 'node --test test/task-proof.test.js passed', '--json'], { cwd: dir, env });
    assert.equal(strongDone.status, 0, strongDone.stderr);

    const weakReady = runCli(['task', 'ready', ref, '--proof', 'done', '--json'], { cwd: dir, env });
    assert.equal(weakReady.status, 2);
    assert.match(weakReady.stdout, /"reason":"weak_proof"|"reason": "weak_proof"/);

    const strongReady = runCli(['task', 'ready', ref, '--proof', 'node --test test/task-proof.test.js passed', '--json'], { cwd: dir, env });
    assert.equal(strongReady.status, 0, strongReady.stderr);

    const review = runCli(['task', 'review', ref, '--reward', '1', '--json'], { cwd: dir, env });
    assert.equal(review.status, 2);
    assert.match(review.stdout, /weak_proof/);
  } finally {
    cleanupTempDir(dir);
  }
});

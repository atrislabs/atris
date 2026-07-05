'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-sweep-auto-accept-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeReceipt(dir, name, result) {
  const rel = path.join('atris', 'runs', name);
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: `mission-${name.replace(/\.json$/, '')}`,
    result,
  }, null, 2) + '\n', 'utf8');
  return rel;
}

function verifiedProof(receiptRel) {
  return `${'context '.repeat(35)}Verifier receipt ${receiptRel} shows the verify passed. Checks: receipt ${receiptRel}; node --test test/task-sweep-auto-accept.test.js passed; git diff --check passed.`;
}

function setupReadyTask(dir, env, { title, tag = 'test', proof }) {
  const created = runCli(['task', 'new', title, '--tag', tag, '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
  const ready = runCli([
    'task', 'ready', task.display_id,
    '--proof', proof,
    '--happened', `Rendered ${title}`,
    '--checked', 'I checked the receipt verifier state before Review.',
    '--tested', 'I inspected the receipt JSON and the named verifier.',
    '--as', 'codex',
    '--json',
  ], { cwd: dir, env });
  assert.equal(ready.status, 0, ready.stderr);
  return task;
}

test('task sweep --auto-accept accepts verified non-protected review tasks with event flags', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeReceipt(dir, 'sweep-pass-receipt.json', {
      verifier_result: { passed: true },
    });
    const task = setupReadyTask(dir, env, {
      title: 'Ship production approval flow',
      tag: 'agent',
      proof: verifiedProof(receiptRel),
    });

    const sweep = runCli(['task', 'sweep', '--auto-accept'], { cwd: dir, env });
    assert.equal(sweep.status, 0, sweep.stderr);
    assert.match(sweep.stdout, /TASK SWEEP AUTO-ACCEPT: 1 accepted \/ 1 scanned \/ 0 skipped/);
    assert.match(sweep.stdout, new RegExp(`ACCEPTED ${task.display_id}: Rendered Ship production approval flow`));
    assert.match(sweep.stdout, /proved by atris\/runs\/sweep-pass-receipt\.json verifier_passed=true/);

    const accepted = JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout);
    assert.equal(accepted.status, 'done');
    assert.equal(accepted.review.approval_status, 'accepted');
    assert.equal(accepted.metadata.auto_accept_policy, 'sweep_auto_accept_verified');

    const events = JSON.parse(runCli(['task', 'events', task.display_id, '--json'], { cwd: dir, env }).stdout).events;
    const completed = events.find((event) => event.event_type === 'completed');
    const reviewed = events.find((event) => event.event_type === 'reviewed');
    assert.equal(completed.payload.auto_accepted, true);
    assert.equal(reviewed.payload.auto_accepted, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task sweep --auto-accept skips protected-lane review tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeReceipt(dir, 'sweep-deploy-receipt.json', {
      tick: { verifier_passed: true },
    });
    const task = setupReadyTask(dir, env, {
      title: 'deploy backend release gate',
      tag: 'deploy',
      proof: verifiedProof(receiptRel),
    });

    const sweep = runCli(['task', 'sweep', '--auto-accept', '--json'], { cwd: dir, env });
    assert.equal(sweep.status, 0, sweep.stderr);
    const payload = JSON.parse(sweep.stdout);
    assert.equal(payload.summary.accepted, 0);
    assert.equal(payload.summary.skipped, 1);
    assert.equal(payload.results[0].ref, task.display_id);
    assert.equal(payload.results[0].reason, 'protected_lane');
    assert.equal(JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task sweep --auto-accept skips needs-human review tasks', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeReceipt(dir, 'sweep-needs-human-receipt.json', {
      tick: { verifier_passed: true },
    });
    const task = setupReadyTask(dir, env, {
      title: 'refresh onboarding copy',
      tag: 'needs-human',
      proof: verifiedProof(receiptRel),
    });

    const sweep = runCli(['task', 'sweep', '--auto-accept', '--json'], { cwd: dir, env });
    assert.equal(sweep.status, 0, sweep.stderr);
    const payload = JSON.parse(sweep.stdout);
    assert.equal(payload.summary.accepted, 0);
    assert.equal(payload.summary.skipped, 1);
    assert.equal(payload.results[0].ref, task.display_id);
    assert.equal(payload.results[0].reason, 'needs_human');
    assert.equal(JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('task sweep --auto-accept skips review tasks without verifier receipt proof', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const task = setupReadyTask(dir, env, {
      title: 'test/refresh proof display',
      tag: 'test',
      proof: `${'context '.repeat(35)}Checks: node --test test/task-sweep-auto-accept.test.js passed and git diff --check passed, but no receipt verifier JSON was attached.`,
    });

    const sweep = runCli(['task', 'sweep', '--auto-accept', '--json'], { cwd: dir, env });
    assert.equal(sweep.status, 0, sweep.stderr);
    const payload = JSON.parse(sweep.stdout);
    assert.equal(payload.summary.accepted, 0);
    assert.equal(payload.results[0].ref, task.display_id);
    assert.equal(payload.results[0].reason, 'no_passing_verifier');
    assert.equal(JSON.parse(runCli(['task', 'show', task.display_id, '--json'], { cwd: dir, env }).stdout).status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

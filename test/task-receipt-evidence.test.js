const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');
const { receiptVerifierPassed } = require('../lib/receipt-evidence');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-receipt-evidence-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMissionReceipt(dir, name, { missionId = 'mission-test-123', passed = true } = {}) {
  const runsDir = path.join(dir, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const rel = path.join('atris', 'runs', name);
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: missionId,
    result: { kind: 'mission_tick', tick: { verifier_passed: passed } },
  }, null, 2) + '\n', 'utf8');
  return rel;
}

// Long enough to pass the meaningful-proof bar, with verifier commands like real proofs.
function certifiedProofMentioning(receiptRel) {
  return `${'context '.repeat(35)}Verifiers: node --check test/task-receipt-evidence.test.js passed, receipt ${receiptRel} attached`;
}

function setupCertifiedTask(dir, env, proof, title = 'Evidence surfacing task') {
  const created = runCli(['task', 'new', title, '--tag', 'evidence', '--json'], { cwd: dir, env });
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout).task;
  assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
  assert.equal(runCli(['task', 'ready', task.display_id, '--proof', proof, '--as', 'codex'], { cwd: dir, env }).status, 0);
  assert.equal(runCli(['task', 'review', task.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);
  return task;
}

test('aggregate receipt failure overrides a nested passing verifier', () => {
  assert.equal(receiptVerifierPassed({
    result: {
      passed: false,
      verifier_result: { passed: true },
      tick: { verifier_passed: true },
    },
  }), false);
});

test('one-lap review evidence requires an independent non-mutating validator', () => {
  const receipt = {
    schema: 'atris.dispatch_receipt.v1',
    review_only: true,
    context: { source: 'one_lap' },
    result: {
      passed: true,
      master_boundary_enforced: true,
      master_unchanged: true,
      verifier_result: { passed: true },
    },
  };
  assert.equal(receiptVerifierPassed(receipt), false, 'executor verification alone is not independent evidence');
  assert.equal(receiptVerifierPassed({
    ...receipt,
    result: {
      ...receipt.result,
      validator_result: {
        engine: 'cursor',
        executor_engine: 'cursor',
        independent: true,
        passed: true,
        worktree_unchanged: true,
      },
    },
  }), false, 'the executor cannot validate itself');
  assert.equal(receiptVerifierPassed({
    ...receipt,
    result: {
      ...receipt.result,
      validator_result: {
        engine: 'codex',
        executor_engine: 'cursor',
        independent: true,
        passed: true,
        worktree_unchanged: true,
      },
    },
  }), true);
  assert.equal(receiptVerifierPassed({
    ...receipt,
    result: {
      ...receipt.result,
      master_boundary_enforced: false,
      master_unchanged: null,
      validator_result: {
        engine: 'codex',
        executor_engine: 'cursor',
        independent: true,
        passed: true,
        worktree_unchanged: true,
      },
    },
  }), false, 'one-lap evidence must prove the protected master boundary');
  assert.equal(receiptVerifierPassed({
    ...receipt,
    context: { source: 'engine_dispatch' },
  }), true, 'generic review-only dispatch keeps its existing verifier contract');
});

test('review queue surfaces validated receipt evidence from proof text', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeMissionReceipt(dir, 'mission-mission-test-123-receipt.json', { passed: true });
    setupCertifiedTask(dir, env, certifiedProofMentioning(receiptRel));

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const payload = JSON.parse(queue.stdout);
    const item = payload.queue.items[0];
    assert.ok(item.evidence, 'queue item must carry receipt evidence');
    assert.equal(item.evidence.receipts.length, 1);
    assert.equal(item.evidence.receipts[0].path, receiptRel);
    assert.equal(item.evidence.receipts[0].verifier_passed, true);
    assert.equal(item.evidence.receipts[0].mission_id, 'mission-test-123');
    assert.deepEqual(item.evidence.missing, []);
    assert.equal(item.evidence.all_passing, true);

    const text = runCli(['task', 'reviews', '--verbose'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /receipt: .*mission-mission-test-123-receipt\.json verifier:passed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review queue flags missing and failing receipts named in proof', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const failingRel = writeMissionReceipt(dir, 'mission-failing-receipt.json', { passed: false });
    const ghostRel = path.join('atris', 'runs', 'mission-ghost-receipt.json');
    const proof = `${'context '.repeat(35)}Verifiers: receipts ${failingRel} and ${ghostRel} attached, node --check passed`;
    setupCertifiedTask(dir, env, proof);

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const item = JSON.parse(queue.stdout).queue.items[0];
    assert.ok(item.evidence);
    assert.equal(item.evidence.receipts.length, 1);
    assert.equal(item.evidence.receipts[0].verifier_passed, false);
    assert.deepEqual(item.evidence.missing, [ghostRel]);
    assert.equal(item.evidence.all_passing, false);

    const text = runCli(['task', 'reviews', '--verbose'], { cwd: dir, env });
    assert.match(text.stdout, /verifier:FAILED/);
    assert.match(text.stdout, /MISSING/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('receipt evidence fails closed when a named receipt has no verifier result', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    const receiptRel = path.join('atris', 'runs', 'fleet-unknown-verifier.json');
    fs.writeFileSync(path.join(dir, receiptRel), JSON.stringify({
      schema: 'atris.fleet_receipt.v1',
      result: { kind: 'fleet_run' },
    }, null, 2) + '\n', 'utf8');
    setupCertifiedTask(dir, env, certifiedProofMentioning(receiptRel));

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const evidence = JSON.parse(queue.stdout).queue.items[0].evidence;
    assert.ok(evidence);
    assert.equal(evidence.receipts.length, 1);
    assert.equal(evidence.receipts[0].path, receiptRel);
    assert.equal(evidence.receipts[0].verifier_passed, undefined);
    assert.equal(evidence.all_passing, false);
  } finally {
    cleanupTempDir(dir);
  }
});

function writeMissionState(dir, records) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'missions.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8'
  );
}

test('forced mission completion is surfaced and never counts as passing evidence', () => {
  const { extractReceiptEvidence } = require('../lib/receipt-evidence');
  const dir = makeTempDir();
  try {
    const receiptRel = writeMissionReceipt(dir, 'mission-forced-receipt.json', {
      missionId: 'mission-forced-1',
      passed: true,
    });
    writeMissionState(dir, [
      { mission: { id: 'mission-forced-1', status: 'complete', completion_gate: { ok: false, forced: true } } },
    ]);
    const evidence = extractReceiptEvidence(certifiedProofMentioning(receiptRel), dir);
    assert.ok(evidence);
    assert.equal(evidence.receipts[0].verifier_passed, true, 'the verifier itself still passed');
    assert.equal(evidence.receipts[0].forced, true);
    assert.equal(evidence.any_forced, true);
    assert.equal(evidence.all_passing, false, 'forced completion must fail closed');

    // Last record wins: an honest unforced re-completion clears the flag.
    writeMissionState(dir, [
      { mission: { id: 'mission-forced-1', status: 'complete', completion_gate: { ok: false, forced: true } } },
      { mission: { id: 'mission-forced-1', status: 'complete', completion_gate: { ok: true, forced: false } } },
    ]);
    const cleared = extractReceiptEvidence(certifiedProofMentioning(receiptRel), dir);
    assert.equal(cleared.any_forced, false);
    assert.equal(cleared.all_passing, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review queue badges forced evidence as forced, not passing', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeMissionReceipt(dir, 'mission-forced-receipt.json', {
      missionId: 'mission-forced-1',
      passed: true,
    });
    writeMissionState(dir, [
      { mission: { id: 'mission-forced-1', status: 'complete', completion_gate: { ok: false, forced: true } } },
    ]);
    const task = setupCertifiedTask(dir, env, certifiedProofMentioning(receiptRel), 'Forced completion task');

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const item = JSON.parse(queue.stdout).queue.items[0];
    assert.equal(item.evidence.any_forced, true);
    assert.equal(item.evidence.all_passing, false);

    const text = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`${task.display_id}.*\\[evidence:forced\\]`));
    assert.doesNotMatch(text.stdout, new RegExp(`${task.display_id}.*\\[evidence:passing\\]`));
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept surfaces receipt evidence without blocking the human', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = {
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
    NODE_NO_WARNINGS: '1',
    // Simulate a human accept even when the suite runs inside an agent env.
    ATRIS_AGENT_PROOF_ONLY: '0',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeMissionReceipt(dir, 'mission-accept-receipt.json', { passed: true });
    const task = setupCertifiedTask(dir, env, certifiedProofMentioning(receiptRel));

    const accepted = runCli(['task', 'accept', task.display_id, '--json'], { cwd: dir, env });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    const payload = JSON.parse(accepted.stdout);
    assert.equal(payload.action, 'accepted');
    assert.ok(payload.evidence, 'accept must report receipt evidence');
    assert.equal(payload.evidence.receipts[0].path, receiptRel);
    assert.equal(payload.evidence.receipts[0].verifier_passed, true);
    assert.equal(payload.evidence.all_passing, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('proofs without receipt paths carry no evidence block', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const proof = `${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, typecheck passed`;
    setupCertifiedTask(dir, env, proof);

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const item = JSON.parse(queue.stdout).queue.items[0];
    assert.equal(item.evidence ?? null, null);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review queue puts green-evidence items first and counts them', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptRel = writeMissionReceipt(dir, 'mission-green-receipt.json', { passed: true });
    // Green task is created FIRST (older updated_at); the prose task is newer.
    const greenTask = setupCertifiedTask(dir, env, certifiedProofMentioning(receiptRel), 'Green evidence task');
    const proseProof = `${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, typecheck passed`;
    const proseTask = setupCertifiedTask(dir, env, proseProof, 'Prose only task');

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const payload = JSON.parse(queue.stdout).queue;
    assert.equal(payload.counts.certified, 2);
    assert.equal(payload.counts.evidence_passing, 1);
    assert.equal(payload.items[0].display_id, greenTask.display_id,
      'validated-evidence item must outrank newer prose-only item');
    assert.equal(payload.items[1].display_id, proseTask.display_id);

    const text = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`${greenTask.display_id}.*\\[evidence:passing\\]`));
    assert.doesNotMatch(text.stdout, new RegExp(`${proseTask.display_id}.*\\[evidence:passing\\]`));
  } finally {
    cleanupTempDir(dir);
  }
});

test('accept-group spot-check targets the weakest evidence first', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const greenRel = writeMissionReceipt(dir, 'mission-green-receipt.json', { passed: true });
    const green = setupCertifiedTask(dir, env, certifiedProofMentioning(greenRel), 'Green receipt task');
    const ghostProof = `${'context '.repeat(35)}Verifiers: receipt atris/runs/mission-ghost-receipt.json attached, node --check passed`;
    const ghost = setupCertifiedTask(dir, env, ghostProof, 'Missing receipt task');
    const proseProof = `${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, typecheck passed`;
    const prose = setupCertifiedTask(dir, env, proseProof, 'Prose only task');

    const preview = runCli(['task', 'accept-group', 'tag=evidence', '--spot-check', '2', '--json'], { cwd: dir, env });
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.action, 'accept_group_preview');
    assert.equal(payload.count, 3);
    const sampleIds = payload.spot_check.map((row) => row.id);
    assert.ok(sampleIds.includes(ghost.id), 'missing-receipt task must be spot-checked');
    assert.ok(sampleIds.includes(prose.id), 'prose-only task must be spot-checked');
    assert.ok(!sampleIds.includes(green.id), 'green-evidence task rides along, not spot-checked');
    const ghostRow = payload.spot_check.find((row) => row.id === ghost.id);
    assert.equal(ghostRow.evidence.all_passing, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review groups report how many tasks carry passing evidence', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const greenRel = writeMissionReceipt(dir, 'mission-green-receipt.json', { passed: true });
    setupCertifiedTask(dir, env, certifiedProofMentioning(greenRel), 'Green receipt task');
    const proseProof = `${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, typecheck passed`;
    setupCertifiedTask(dir, env, proseProof, 'Prose only task');

    const groups = runCli(['task', 'reviews', '--group-by', 'tag', '--json'], { cwd: dir, env });
    assert.equal(groups.status, 0, groups.stderr);
    const group = JSON.parse(groups.stdout).groups.groups.find((entry) => entry.value === 'evidence');
    assert.ok(group);
    assert.equal(group.count, 2);
    assert.equal(group.evidence_passing, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

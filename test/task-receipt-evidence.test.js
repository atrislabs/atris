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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-receipt-evidence-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
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
  return `${'context '.repeat(35)}Verifiers: node --test test/task-receipt-evidence.test.js passed, receipt ${receiptRel} attached, git diff --check -- commands/task.js clean`;
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
    const proof = `${'context '.repeat(35)}Verifiers: receipts ${failingRel} and ${ghostRel} attached, node --test passed`;
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
    const proof = `${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, git diff --check clean`;
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
    const proseProof = `${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, git diff --check clean`;
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
    const ghostProof = `${'context '.repeat(35)}Verifiers: receipt atris/runs/mission-ghost-receipt.json attached, node --test passed`;
    const ghost = setupCertifiedTask(dir, env, ghostProof, 'Missing receipt task');
    const proseProof = `${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, git diff --check clean`;
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
    const proseProof = `${'context '.repeat(35)}Verifiers: node --test test/commands.test.js passed, git diff --check clean`;
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

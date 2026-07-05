const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { writeTaskReceipt } = require('../lib/task-receipt');
const { extractReceiptEvidence } = require('../lib/receipt-evidence');
const { scrubAgentEnv } = require('./helpers/agent-env');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-receipt-'));
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

test('writeTaskReceipt writes a passing receipt with task id, command, exit, commit, timestamp', () => {
  const dir = makeTempDir();
  try {
    const receipt = writeTaskReceipt({ taskId: 'CLI-900', command: 'echo hi', root: dir });
    assert.equal(receipt.passed, true);
    assert.equal(receipt.exit, 0);
    assert.ok(receipt.receiptPath.startsWith('atris/runs/'));
    const full = path.join(dir, receipt.receiptPath);
    assert.ok(fs.existsSync(full));
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    assert.equal(parsed.schema, 'atris.task_receipt.v1');
    assert.equal(parsed.task_id, 'CLI-900');
    assert.equal(parsed.command, 'echo hi');
    assert.equal(parsed.result.passed, true);
    assert.equal(parsed.result.exit, 0);
    assert.match(parsed.result.output, /hi/);
    assert.ok(parsed.at);
    // commit is nullable outside a git repo, but the field must exist
    assert.ok('commit' in parsed);
  } finally {
    cleanupTempDir(dir);
  }
});

test('writeTaskReceipt still writes a receipt when the verifier fails', () => {
  const dir = makeTempDir();
  try {
    const receipt = writeTaskReceipt({ taskId: 'CLI-901', command: 'exit 7', root: dir });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.exit, 7);
    const full = path.join(dir, receipt.receiptPath);
    assert.ok(fs.existsSync(full));
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    assert.equal(parsed.result.passed, false);
    assert.equal(parsed.result.exit, 7);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task receipt writes evidence without moving the task to ready', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Receipt-only task', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const receiptRun = runCli(['task', 'receipt', ref, '--verify', 'true', '--json'], { cwd: dir, env });
    assert.equal(receiptRun.status, 0, receiptRun.stderr);
    const parsed = JSON.parse(receiptRun.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.receipt_path.startsWith('atris/runs/'));
    assert.ok(fs.existsSync(path.join(dir, parsed.receipt_path)));

    // Task is still open — receipt did not move it to review.
    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout).task || JSON.parse(show.stdout);
    assert.notEqual(task.status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris task receipt exits non-zero and still records a failing verifier run', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Receipt-only failing task', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const receiptRun = runCli(['task', 'receipt', ref, '--verify', 'exit 5', '--json'], { cwd: dir, env });
    assert.equal(receiptRun.status, 1);
    const parsed = JSON.parse(receiptRun.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exit, 5);
    assert.ok(fs.existsSync(path.join(dir, parsed.receipt_path)));
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready --verify writes a receipt and the proof cites the receipt path', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Receipt-backed ready task', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const ready = runCli(['task', 'ready', ref, '--verify', 'true', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const task = JSON.parse(ready.stdout).task;
    assert.match(task.review.proof, /\[verified\] `true` passed \(exit 0\)/);
    const receiptMatch = task.review.proof.match(/Receipt: (atris\/runs\/\S+\.json)/);
    assert.ok(receiptMatch, `proof should cite a receipt path: ${task.review.proof}`);
    const receiptRel = receiptMatch[1];
    assert.ok(fs.existsSync(path.join(dir, receiptRel)));

    // The review-gate evidence extractor should validate the cited receipt.
    const evidence = extractReceiptEvidence(task.review.proof, dir);
    assert.ok(evidence, 'evidence should be extracted from the proof');
    assert.equal(evidence.all_passing, true);
    assert.equal(evidence.receipts[0].path, receiptRel);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready --verify failure blocks ready but still writes a failing receipt', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const add = runCli(['task', 'add', 'Receipt-backed failing ready task', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const ready = runCli(['task', 'ready', ref, '--verify', 'exit 2'], { cwd: dir, env });
    assert.equal(ready.status, 1);
    assert.match(ready.stderr, /verifier failed/);
    const receiptMatch = ready.stderr.match(/receipt: (atris\/runs\/\S+\.json)/);
    assert.ok(receiptMatch, `stderr should name the receipt path: ${ready.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, receiptMatch[1])));

    // Task must still be open — no receipt path can force a ready over a failed verifier.
    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout).task || JSON.parse(show.stdout);
    assert.notEqual(task.status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-proof-projection-')));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeReceipt(dir, name = 'mission-proof-projection-receipt.json') {
  const rel = path.join('atris', 'runs', name);
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-proof-projection',
    result: { kind: 'mission_tick', tick: { verifier_passed: true } },
  }, null, 2) + '\n', 'utf8');
  return rel;
}

async function runStatusProjection(dir, dbPath) {
  const previousCwd = process.cwd();
  const previousDb = process.env.ATRIS_TASKS_DB;
  const previousSkipUpdate = process.env.ATRIS_SKIP_UPDATE_CHECK;
  const previousNoWarnings = process.env.NODE_NO_WARNINGS;
  const originalWrite = process.stdout.write;

  process.chdir(dir);
  process.env.ATRIS_TASKS_DB = dbPath;
  process.env.ATRIS_SKIP_UPDATE_CHECK = '1';
  process.env.NODE_NO_WARNINGS = '1';
  process.stdout.write = function captureWrite(chunk, ...args) {
    if (typeof args[args.length - 1] === 'function') args[args.length - 1]();
    return true;
  };

  try {
    const taskCommand = require('../commands/task');
    await taskCommand.run(['status']);
    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    return JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(previousCwd);
    if (previousDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = previousDb;
    if (previousSkipUpdate === undefined) delete process.env.ATRIS_SKIP_UPDATE_CHECK;
    else process.env.ATRIS_SKIP_UPDATE_CHECK = previousSkipUpdate;
    if (previousNoWarnings === undefined) delete process.env.NODE_NO_WARNINGS;
    else process.env.NODE_NO_WARNINGS = previousNoWarnings;
  }
}

test('readyTask proof is preserved in enriched projection with receipt_path', async () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptPath = writeReceipt(dir);
    const proof = `Verified node --test test/task-proof-projection.test.js passed. Receipt: ${receiptPath}. git diff --check passed.`;
    const db = taskDb.open(dbPath);
    const created = taskDb.addTask(db, {
      title: 'Project proof text into review',
      tag: 'proof',
      workspaceRoot: dir,
      status: 'claimed',
      claimedBy: 'codex',
    });
    taskDb.readyTask(db, { id: created.id, actor: 'codex', proof });
    taskDb.close();

    const projection = await runStatusProjection(dir, dbPath);
    const task = projection.tasks.find(row => row.id === created.id);
    assert.equal(task.review.proof, proof);
    assert.equal(task.review.receipt_path, receiptPath);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('direct review-lane task uses imported verify text as projection proof', async () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptPath = writeReceipt(dir, 'mission-imported-review-receipt.json');
    const proof = `Imported Review proof: node --test test/task-proof-projection.test.js passed. Receipt: ${receiptPath}.`;
    const db = taskDb.open(dbPath);
    const created = taskDb.addTask(db, {
      title: 'Imported TODO review row keeps proof',
      tag: 'import',
      workspaceRoot: dir,
      status: 'review',
      claimedBy: 'codex',
      metadata: { verify: proof },
    });
    taskDb.close();

    const projection = await runStatusProjection(dir, dbPath);
    const task = projection.tasks.find(row => row.id === created.id);
    assert.equal(task.status, 'review');
    assert.ok(task.review, 'review-lane task with verify proof must expose review metadata');
    assert.equal(task.review.proof, proof);
    assert.equal(task.review.receipt_path, receiptPath);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('direct review-lane task uses proof-like message history as projection proof', async () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const receiptPath = writeReceipt(dir, 'mission-message-review-receipt.json');
    const proof = `Message proof: verified node --test test/task-proof-projection.test.js passed. Receipt ${receiptPath}.`;
    const db = taskDb.open(dbPath);
    const created = taskDb.addTask(db, {
      title: 'Imported review row with message proof',
      tag: 'import',
      workspaceRoot: dir,
      status: 'review',
      claimedBy: 'codex',
    });
    taskDb.noteTask(db, { id: created.id, actor: 'codex', content: proof });
    taskDb.close();

    const projection = await runStatusProjection(dir, dbPath);
    const task = projection.tasks.find(row => row.id === created.id);
    assert.equal(task.status, 'review');
    assert.ok(task.review, 'review-lane task with proof message must expose review metadata');
    assert.equal(task.review.proof, proof);
    assert.equal(task.review.receipt_path, receiptPath);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

test('direct review-lane task without proof keeps review proof null', async () => {
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskDb.open(dbPath);
    const created = taskDb.addTask(db, {
      title: 'Imported TODO review row without proof',
      tag: 'import',
      workspaceRoot: dir,
      status: 'review',
      claimedBy: 'codex',
    });
    taskDb.close();

    const projection = await runStatusProjection(dir, dbPath);
    const task = projection.tasks.find(row => row.id === created.id);
    assert.equal(task.status, 'review');
    assert.equal(task.review, null);
  } finally {
    taskDb.close();
    cleanupTempDir(dir);
  }
});

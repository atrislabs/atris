'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const INIT_TIMEOUT_MS = 120000;

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function runCli(args, { cwd, env, timeout = 30000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function markerCount(workspace) {
  const file = path.join(workspace, 'marker.log');
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function writeReceipt(workspace, name, result) {
  const rel = path.join('atris', 'runs', name);
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    mission_id: `mission-${name.replace(/\.json$/, '')}`,
    result,
  }, null, 2) + '\n', 'utf8');
  return rel;
}

// The reviews auto-accept size gate reads diff stats out of the proof text.
// certify-verified rewrites the proof as its own sentence plus the FIRST 200
// chars of the builder proof, so the diffstat must lead or it is truncated
// away and every row queues as size_unknown.
function smallProof(receiptRel) {
  return `1 file changed, 2 insertions(+). ${'context '.repeat(30)}Verifier receipt ${receiptRel} shows the verify passed. Checks: receipt ${receiptRel}; node scripts/marker.js passed; git diff --check passed.`;
}

// `task reviews` is a READ path: it must never spawn a stored verify. The
// verdict it acts on comes from metadata.verify_cache, stamped by the two
// lanes allowed to execute (certify-verified, autoland landing). This test
// counts actual verify executions via a marker file.
test('reviews never executes verifies; it reads metadata.verify_cache', () => {
  if (!hasNodeSqlite()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reviews-read-path-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
  };

  try {
    const init = runCli(['init', '--yes'], { cwd: workspace, env, timeout: INIT_TIMEOUT_MS });
    assert.equal(init.status, 0, init.stderr);

    fs.mkdirSync(path.join(workspace, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'scripts', 'marker.js'),
      "require('node:fs').appendFileSync('marker.log', 'ran\\n');\n"
    );

    // Task A: certified — its verify_cache gets stamped by certify-verified.
    const receiptA = writeReceipt(workspace, 'read-path-a-receipt.json', { verifier_result: { passed: true } });
    const delegatedA = JSON.parse(runCli(['task', 'delegate', 'read path A', '--to', 'demo', '--json'], { cwd: workspace, env }).stdout);
    const refA = delegatedA.task?.display_id || delegatedA.task_id;
    assert.equal(runCli(['task', 'claim', refA, '--as', 'demo', '--json'], { cwd: workspace, env }).status, 0);
    const readyA = runCli([
      'task', 'ready', refA, '--as', 'demo',
      '--verify', 'node scripts/marker.js',
      '--proof', smallProof(receiptA),
      '--result', 'Operators can now read the review verdict in one pass instead of waiting for checks to re-run.',
      '--json',
    ], { cwd: workspace, env });
    assert.equal(readyA.status, 0, readyA.stderr);
    assert.equal(markerCount(workspace), 1, 'ready runs the verify once');

    // Task B: same verify, certified in the same run, then made STALE by
    // rewriting its stored verify so cache.command no longer matches.
    const receiptB = writeReceipt(workspace, 'read-path-b-receipt.json', { verifier_result: { passed: true } });
    const delegatedB = JSON.parse(runCli(['task', 'delegate', 'read path B', '--to', 'demo', '--json'], { cwd: workspace, env }).stdout);
    const refB = delegatedB.task?.display_id || delegatedB.task_id;
    assert.equal(runCli(['task', 'claim', refB, '--as', 'demo', '--json'], { cwd: workspace, env }).status, 0);
    const readyB = runCli([
      'task', 'ready', refB, '--as', 'demo',
      '--verify', 'node scripts/marker.js',
      '--proof', smallProof(receiptB),
      '--result', 'Operators can now see which reviews still need a check instead of guessing from raw output.',
      '--json',
    ], { cwd: workspace, env });
    assert.equal(readyB.status, 0, readyB.stderr);
    assert.equal(markerCount(workspace), 2, 'each ready runs the verify once');

    const certified = JSON.parse(runCli(['task', 'certify-verified', '--json'], { cwd: workspace, env }).stdout);
    assert.equal(certified.certified, 2, JSON.stringify(certified.results));
    assert.equal(markerCount(workspace), 4, 'certify-verified executes each check');

    const showA = JSON.parse(runCli(['task', 'show', refA, '--json'], { cwd: workspace, env }).stdout);
    assert.equal(showA.metadata?.verify_cache?.ok, true, 'certify stamps verify_cache');
    assert.equal(showA.metadata?.verify_cache?.command, 'node scripts/marker.js');

    // Stale-cache fixture: the stored verify moved after the cache was
    // stamped, so the read path must treat B as verification_pending.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'tasks.db'));
    const rowB = db.prepare('SELECT id, metadata FROM tasks WHERE id = ?').get(delegatedB.task.id);
    const metaB = JSON.parse(rowB.metadata);
    metaB.verify = 'node scripts/changed-after-stamp.js';
    db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metaB), rowB.id);
    db.close();

    // The read path: zero new executions, A accepted from cache, B pending.
    const reviews = runCli(['task', 'reviews', '--json'], { cwd: workspace, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    assert.equal(markerCount(workspace), 4, 'reviews must not execute any verify');

    const doneA = JSON.parse(runCli(['task', 'show', refA, '--json'], { cwd: workspace, env }).stdout);
    assert.equal(doneA.status, 'done', 'A auto-accepts from the stamped cache');

    const stillB = JSON.parse(runCli(['task', 'show', refB, '--json'], { cwd: workspace, env }).stdout);
    assert.equal(stillB.status, 'review', 'B waits for a write lane to verify');
    assert.match(reviews.stdout, /verification_pending/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

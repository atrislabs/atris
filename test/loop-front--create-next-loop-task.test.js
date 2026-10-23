'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate all state before loading the module under test: a throwaway HOME and
// task db, and none of the ATRIS_* knobs from the surrounding environment.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-front-create-next-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = tmp;
process.env.ATRIS_TEST_STATE_DIR = path.join(tmp, 'state-home');
process.env.ATRIS_TASKS_DB = path.join(tmp, 'tasks.db');

const { createNextLoopTask } = require('../commands/loop-front');

const SEED_TITLE = 'Create the next proof-backed self-improvement task';

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRoot() {
  return fs.mkdtempSync(path.join(tmp, 'root-'));
}

function writeActiveMission(root, objective = 'Keep the loop improving') {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'missions.jsonl'),
    `${JSON.stringify({ id: 'm1', status: 'active', objective })}\n`,
    'utf8',
  );
}

test('empty workspace is skipped with no_seed', () => {
  const root = makeRoot();
  const res = createNextLoopTask([], root, { print: false });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.action, 'create_next_skipped');
  assert.strictEqual(res.reason, 'no_seed');
  assert.strictEqual(res.move, null);
});

test('an in-flight task wins over an available mission seed', () => {
  const root = makeRoot();
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const projectionPath = path.join(stateDir, 'tasks.projection.json');
  fs.writeFileSync(projectionPath, `${JSON.stringify({
    tasks: [{
      id: 't1',
      display_id: 'T1',
      title: 'Fix the flaky login test',
      status: 'claimed',
      claimed_by: 'tester-bot',
      tag: 'loop',
    }],
  })}\n`, 'utf8');
  writeActiveMission(root);

  const res = createNextLoopTask([], root, { print: false });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.action, 'create_next_skipped');
  assert.strictEqual(res.reason, 'active_task');
  assert.strictEqual(res.move.source, 'task');
  assert.strictEqual(res.move.title, 'Fix the flaky login test');
  assert.strictEqual(res.move.ref, 'T1');

  // Skip means skip: nothing delegated, projection untouched.
  const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
  assert.strictEqual(projection.tasks.length, 1);
  assert.strictEqual(projection.tasks[0].id, 't1');
});

test('mission seed creates and claims the next loop task', () => {
  const root = makeRoot();
  writeActiveMission(root);

  const res = createNextLoopTask(['--as', 'tester-bot', '--json'], root, { print: false });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'created_next');
  assert.strictEqual(res.owner, 'tester-bot');
  assert.strictEqual(res.move.source, 'mission');
  assert.strictEqual(res.move.title, SEED_TITLE);
  assert.strictEqual(res.move.why, 'active mission has no concrete task queued');

  assert.ok(res.task, 'expected the delegated task payload');
  assert.strictEqual(res.task.title, SEED_TITLE);
  assert.strictEqual(res.task.status, 'claimed');
  assert.strictEqual(res.task.tag, 'loop');
  assert.strictEqual(res.task.claimed_by, 'tester-bot');

  // The task really landed in this workspace's projection.
  const projectionPath = path.join(root, '.atris', 'state', 'tasks.projection.json');
  const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
  const created = projection.tasks.find((t) => t.id === res.task.id);
  assert.ok(created, 'created task missing from workspace projection');
  assert.strictEqual(created.title, SEED_TITLE);
  assert.strictEqual(created.claimed_by, 'tester-bot');
});

test('a failing task delegate reports create_next_failed', () => {
  const root = makeRoot();
  writeActiveMission(root);
  // Poison the task db path: its parent is a regular file, so the spawned
  // delegate cannot open the db and exits non-zero.
  const blocker = path.join(root, 'not-a-dir');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const previous = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = path.join(blocker, 'tasks.db');
  try {
    const res = createNextLoopTask(['--as', 'tester-bot'], root, { print: false });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.action, 'create_next_failed');
    assert.strictEqual(res.reason, 'task_delegate_failed');
  } finally {
    process.env.ATRIS_TASKS_DB = previous;
  }
});

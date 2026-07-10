'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMissionBlocker } = require('../lib/self-drive');

function harness({ engine = { id: 'codex' } } = {}) {
  const rows = [];
  const events = [];
  let dispatches = 0;
  const taskDb = {
    open: () => ({}),
    workspaceRoot: (root) => root,
    listTasks: () => rows,
    withTaskDisplayRefs: (tasks) => tasks.map((task, index) => ({ ...task, display_id: `CLI-${index + 1}` })),
    addTask: (_db, input) => {
      const task = { id: `task-${rows.length + 1}`, status: 'open', ...input };
      rows.push(task);
      return { id: task.id, inserted: true };
    },
    getTask: (_db, id) => rows.find((row) => row.id === id),
    claimTask: (_db, { id, claimedBy }) => {
      const row = rows.find((item) => item.id === id);
      row.status = 'claimed';
      row.claimed_by = claimedBy;
      return { claimed: true, row };
    },
  };
  const deps = {
    taskDb,
    resolveEngineForRole: () => engine,
    createAgentWorktree: () => ({ path: '/tmp/self-drive-worktree' }),
    dispatchToEngine: () => { dispatches += 1; return { exitCode: 0 }; },
  };
  const mission = { id: 'mission-1', objective: 'ship reliable missions', status: 'paused', receipt_path: 'atris/runs/tick.json' };
  const run = (stopReason = 'repeated-error:runner-failed') => handleMissionBlocker({
    mission,
    stopReason,
    workspaceRoot: '/tmp/workspace',
    appendEvent: (type, payload) => events.push({ type, payload }),
  }, deps);
  return { rows, events, run, dispatches: () => dispatches };
}

test('dedup returns the existing open blocker task', () => {
  const h = harness();
  const first = h.run();
  const second = h.run();
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.reason, 'existing blocker task');
  assert.equal(h.rows.length, 1);
  assert.equal(h.dispatches(), 1);
  assert.equal(h.events.filter((event) => event.type === 'mission_blocker_task_filed').length, 1);
});

test('human-blocking reasons do not file or dispatch tasks', () => {
  const h = harness();
  const result = h.run('auth-required');
  assert.deepEqual(result, { taskId: null, dispatched: false, engine: null, reason: 'human-blocking' });
  assert.equal(h.rows.length, 0);
  assert.equal(h.dispatches(), 0);
});

test('no ready engine leaves the blocker filed', () => {
  const h = harness({ engine: null });
  const result = h.run();
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'no ready executor engine');
  assert.equal(h.rows[0].status, 'open');
});

test('ready executor receives the claimed blocker task', () => {
  const h = harness();
  const result = h.run();
  assert.equal(result.dispatched, true);
  assert.equal(result.engine, 'codex');
  assert.equal(h.rows[0].status, 'claimed');
  assert.equal(h.dispatches(), 1);
  assert.deepEqual(h.events.map((event) => event.type), [
    'mission_blocker_task_filed',
    'mission_blocker_dispatched',
  ]);
});

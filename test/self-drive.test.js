'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMissionBlocker } = require('../lib/self-drive');

function harness({ engine = { id: 'codex' }, httpPost, loadSwarloApiKey } = {}) {
  const rows = [];
  const events = [];
  const dialogue = [];
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
    noteTask: (_db, note) => {
      dialogue.push(note);
      return { noted: true };
    },
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
    // Never hit the real swarlo hub from tests: default to a no-key stub
    // (postBlockerToFleet short-circuits before any network call).
    loadSwarloApiKey: loadSwarloApiKey || (() => null),
    httpPost: httpPost || (() => { throw new Error('unexpected network call in test'); }),
  };
  const mission = { id: 'mission-1', objective: 'ship reliable missions', status: 'paused', receipt_path: 'atris/runs/tick.json' };
  const run = (stopReason = 'repeated-error:runner-failed') => handleMissionBlocker({
    mission,
    stopReason,
    workspaceRoot: '/tmp/workspace',
    appendEvent: (type, payload) => events.push({ type, payload }),
  }, deps);
  return { rows, events, dialogue, run, dispatches: () => dispatches };
}

test('blocker tasks use short plain titles and keep full context in dialogue', () => {
  const h = harness();
  h.run('repeated-error:runner-failed-because-the-provider-returned-an-unexpected-response');
  const task = h.rows[0];
  assert.equal(task.title.startsWith('get '), true);
  assert.equal(task.title.includes('"'), false);
  assert.equal(task.title.includes('Evidence:'), false);
  assert.ok(task.title.length < 90, task.title);
  assert.equal(task.metadata.mission_objective, 'ship reliable missions');
  assert.equal(task.metadata.stop_reason, 'repeated-error:runner-failed-because-the-provider-returned-an-unexpected-response');
  assert.equal(task.metadata.evidence, 'atris/runs/tick.json');
  assert.match(h.dialogue[0].content, /Mission objective: ship reliable missions/);
  assert.match(h.dialogue[0].content, /Stop reason: repeated-error:runner-failed/);
  assert.match(h.dialogue[0].content, /Evidence: atris\/runs\/tick.json/);
});

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

test('no engine + fleet post succeeds escalates to swarlo and appends event', () => {
  let calledWith = null;
  const h = harness({
    engine: null,
    loadSwarloApiKey: () => 'test-key',
    httpPost: (url, opts) => {
      calledWith = { url, opts };
      return { ok: true, status: 201, body: '{"post_id":"p1"}' };
    },
  });
  const result = h.run();
  assert.equal(result.dispatched, false);
  assert.equal(result.fleet_posted, true);
  assert.equal(result.reason, 'no ready executor engine; escalated to fleet');
  assert.ok(calledWith.url.includes('/channels/escalations/posts'));
  assert.ok(calledWith.opts.headers.Authorization.includes('test-key'));
  assert.deepEqual(h.events.map((event) => event.type), [
    'mission_blocker_task_filed',
    'mission_blocker_fleet_escalated',
  ]);
  const escalated = h.events.find((event) => event.type === 'mission_blocker_fleet_escalated');
  assert.equal(escalated.payload.channel, 'escalations');
  assert.ok(escalated.payload.task_id);
  assert.ok(escalated.payload.blocker_class);
});

test('no engine + fleet post fails (hub down) does not throw and reports fleet_posted false', () => {
  const h = harness({
    engine: null,
    loadSwarloApiKey: () => 'test-key',
    httpPost: () => { throw new Error('connect ECONNREFUSED'); },
  });
  const result = h.run();
  assert.equal(result.dispatched, false);
  assert.equal(result.fleet_posted, false);
  assert.equal(result.reason, 'no ready executor engine');
  assert.equal(h.events.some((event) => event.type === 'mission_blocker_fleet_escalated'), false);
});

test('engine ready never attempts a fleet post', () => {
  let called = false;
  const h = harness({
    engine: { id: 'codex' },
    loadSwarloApiKey: () => 'test-key',
    httpPost: () => { called = true; return { ok: true, status: 201, body: '{}' }; },
  });
  h.run();
  assert.equal(called, false);
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

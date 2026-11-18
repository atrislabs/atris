'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');
const { staffFlight } = require('../lib/fleet');
const { handleMissionBlocker } = require('../lib/self-drive');

function fixture(t, tags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-inspection-hold-'));
  const ws = fs.realpathSync(dir), db = tasks.open(path.join(dir, 'tasks.db'));
  t.after(() => { tasks.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const metadata = { mission_id: 'fixture', mission_blocker_class: 'stopped', keep: 'saved' };
  if (tags !== undefined) metadata.tags = tags;
  const task = tasks.addTask(db, { title: 'edit lib/example.js', workspaceRoot: ws, status: 'done', metadata });
  const run = (connection = db) => handleMissionBlocker({ mission: {id: 'fixture', status: 'paused', objective: 'synthetic'}, stopReason: 'stopped', workspaceRoot: ws }, {
    taskDb: {...tasks, open: () => connection},
    resolveEngineForRole: () => { throw Error('unexpected engine'); },
    createAgentWorktree: () => { throw Error('unexpected worker'); },
    dispatchToEngine: () => { throw Error('unexpected worker'); },
    httpPost: () => { throw Error('unexpected post'); },
  });
  return {db, ws, task, run};
}
for (const tags of [undefined, [], ['other', 'needs-human', 'manual'], ['needs_human', 'other']]) {
  test(`reopen holds work and preserves tags ${JSON.stringify(tags)}`, t => {
    const f = fixture(t, tags), result = f.run(), row = tasks.getTask(f.db, f.task.id);
    assert.equal(result.inspection_hold, 'needs-human');
    assert.match(result.inspection_reason, /human inspection/);
    const expected = tags || [];
    assert.deepEqual(row.metadata.tags, expected.includes('needs-human') ? expected : [...expected, 'needs-human']);
    assert.equal(row.metadata.keep, 'saved');
    assert.equal(row.status, 'open');
    assert.deepEqual(staffFlight([row]), []);
    const event = tasks.listTaskEvents(f.db, {taskId: f.task.id}).at(-1);
    assert.equal(event.event_type, 'reopened');
    assert.equal(event.payload.inspection_hold, 'needs-human');
    assert.match(event.payload.inspection_reason, /human inspection/);
    assert.equal(f.run().reason, 'existing blocker task');
  });
}
for (const tags of [null, 'needs-human', [null], [''], [2], {}]) {
  test(`invalid tags fail closed ${JSON.stringify(tags)}`, t => {
    const f = fixture(t, tags), before = tasks.getTask(f.db, f.task.id);
    const history = tasks.listTaskEvents(f.db, {taskId: f.task.id});
    assert.equal(f.run().reason, 'reopen needs inspection');
    assert.deepEqual(tasks.getTask(f.db, f.task.id), before);
    assert.deepEqual(tasks.listTaskEvents(f.db, {taskId: f.task.id}), history);
  });
}
test('guard is mandatory for inspection but ordinary reopen is unchanged', t => {
  const f = fixture(t, ['original']);
  for (const input of [{}, {expectedWorkspace:f.ws, expectedSnapshot:'bad'}, {expectedSnapshot:tasks.taskRowSnapshot(f.db,f.task.id)}]) {
    assert.equal(tasks.reopenTask(f.db, {id:f.task.id, inspectionHold:true, ...input}).reason, 'invalid_inspection_guard');
  }
  const ordinary = tasks.reopenTask(f.db, {id:f.task.id});
  assert.equal(ordinary.reopened, true);
  assert.deepEqual(ordinary.row.metadata.tags, ['original']);
  assert.equal(ordinary.event.payload.inspection_hold, undefined);
});
test('failed reopen event rolls the hold and row back together', t => {
  const f = fixture(t, ['prior']), before = tasks.getTask(f.db,f.task.id), history = tasks.listTaskEvents(f.db,{taskId:f.task.id});
  f.db.exec("CREATE TRIGGER reject_inspection BEFORE INSERT ON task_events WHEN NEW.event_type = 'reopened' BEGIN SELECT RAISE(ABORT, 'reject fixture'); END");
  assert.throws(() => f.run(), /reject fixture/);
  assert.deepEqual(tasks.getTask(f.db,f.task.id),before);
  assert.deepEqual(tasks.listTaskEvents(f.db,{taskId:f.task.id}),history);
});
for (const commitFirst of [false,true]) test(`unknown reopen commit ${commitFirst ? 'after' : 'before'} commit never starts a worker`, t => {
  const f = fixture(t), original = f.db;
  const wrapped = {prepare: sql => original.prepare(sql), exec(sql) {
    // Only interrupt the write transaction's commit, not the initial read.
    if (sql === 'BEGIN IMMEDIATE') this.writing = true;
    if (sql === 'COMMIT' && this.writing) { if (commitFirst) original.exec(sql); throw Error('lost response'); }
    return original.exec(sql);
  }};
  assert.throws(() => f.run(wrapped), error => error.code === 'TASK_REOPEN_COMMIT_UNCERTAIN');
  const row = tasks.getTask(original,f.task.id);
  assert.equal(row.status,commitFirst ? 'open' : 'done');
  if (commitFirst) assert.ok(row.metadata.tags.includes('needs-human'));
  else assert.equal(row.metadata.tags,undefined);
});
test('inspection refuses malformed raw metadata and a tags replacement patch', t => {
  const f=fixture(t,['prior']);
  const snapshot=tasks.taskRowSnapshot(f.db,f.task.id);
  assert.equal(tasks.reopenTask(f.db,{id:f.task.id,inspectionHold:true,expectedWorkspace:f.ws,expectedSnapshot:snapshot,metadata:{tags:['replacement']}}).reason,'invalid_inspection_tags');
  f.db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run('{invalid',f.task.id);
  const bad=tasks.taskRowSnapshot(f.db,f.task.id);
  assert.equal(tasks.reopenTask(f.db,{id:f.task.id,inspectionHold:true,expectedWorkspace:f.ws,expectedSnapshot:bad}).reason,'invalid_inspection_tags');
  assert.equal(f.db.prepare('SELECT metadata FROM tasks WHERE id=?').get(f.task.id).metadata,'{invalid');
  assert.equal(tasks.getTask(f.db,f.task.id).status,'done');
});
test('inspection hold is picker policy, not a database claim lock', t => {
  const f=fixture(t); assert.equal(f.run().inspection_hold,'needs-human');
  const claim=tasks.claimTask(f.db,{id:f.task.id,claimedBy:'manual'});
  assert.equal(claim.claimed,true);
  assert.equal(claim.row.metadata.tags.includes('needs-human'),true);
});

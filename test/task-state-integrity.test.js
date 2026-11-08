'use strict';

// Task state stays whole when a write is cut short or raced: done and its event land
// together, accept is one write, metadata stamps never drop each other's keys, hand
// claims are let go after a long silence, a rendered TODO keeps hand-added bullets,
// autopilot finishes the job behind a rendered bullet, and file views are written whole.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-integrity-'));
const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'HOME' || key === 'USER' || key.startsWith('ATRIS_')));
for (const key of Object.keys(process.env)) if (key.startsWith('ATRIS_')) delete process.env[key];
process.env.HOME = tmpRoot;
process.env.ATRIS_TASKS_DB = path.join(tmpRoot, 'tasks.db');
delete process.env.USER;

const taskDb = require('../lib/task-db');
const taskCmd = require('../commands/task');
const { writeFileAtomic } = require('../lib/json-file');

const WORKSPACE = path.join(tmpRoot, 'workspace');
fs.mkdirSync(path.join(WORKSPACE, 'atris'), { recursive: true });
const ws = taskDb.workspaceRoot(WORKSPACE);

test.after(() => {
  taskDb.close();
  for (const key of Object.keys(process.env)) if (key === 'HOME' || key === 'USER' || key.startsWith('ATRIS_')) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function events(db, id, type) {
  return db.prepare('SELECT event_type FROM task_events WHERE task_id = ? AND event_type = ?').all(id, type);
}

function claimedTask(db, title, claimedBy = 'person') {
  const { id } = taskDb.addTask(db, { title, workspaceRoot: ws });
  assert.equal(taskDb.claimTask(db, { id, claimedBy }).claimed, true);
  return id;
}

test('doneTask rolls the status back when its event cannot be written', () => {
  const db = taskDb.open();
  const id = claimedTask(db, 'Finish the export screen');
  db.exec(`CREATE TEMP TRIGGER fail_completed BEFORE INSERT ON task_events
    WHEN NEW.event_type = 'completed' BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);
  try {
    assert.throws(() => taskDb.doneTask(db, { id, actor: 'person', proof: 'checked' }), /event write failed/);
  } finally {
    db.exec('DROP TRIGGER fail_completed');
  }
  assert.equal(taskDb.getTask(db, id).status, 'claimed');
  const done = taskDb.doneTask(db, { id, actor: 'person', proof: 'checked' });
  assert.equal(done.updated, true);
  assert.equal(taskDb.getTask(db, id).status, 'done');
  assert.equal(events(db, id, 'completed').length, 1);
});

test('acceptTask marks done and accepted in one write, or neither', () => {
  const db = taskDb.open();
  const id = claimedTask(db, 'Ship the billing page');
  db.exec(`CREATE TEMP TRIGGER fail_reviewed BEFORE INSERT ON task_events
    WHEN NEW.event_type = 'reviewed' BEGIN SELECT RAISE(ABORT, 'review write failed'); END`);
  try {
    assert.throws(() => taskDb.acceptTask(db, { id, actor: 'judge', reward: 1, proof: 'checked by hand' }), /review write failed/);
  } finally {
    db.exec('DROP TRIGGER fail_reviewed');
  }
  const after = taskDb.getTask(db, id);
  assert.equal(after.status, 'claimed', 'a failed accept leaves no half-done row');
  assert.equal(events(db, id, 'completed').length, 0);

  const accepted = taskDb.acceptTask(db, { id, actor: 'judge', reward: 1, proof: 'checked by hand' });
  assert.equal(accepted.updated, true);
  assert.equal(accepted.reviewed.reviewed, true);
  const row = taskDb.getTask(db, id);
  assert.equal(row.status, 'done');
  assert.equal(row.metadata.approval_status, 'accepted');
  assert.equal(taskDb.acceptTask(db, { id, actor: 'judge', reward: 1 }).updated, false);
});

test('updateTaskMetadata keeps keys another writer saved after the caller read the row', () => {
  const db = taskDb.open();
  const { id } = taskDb.addTask(db, { title: 'Stamp two things', workspaceRoot: ws });
  const before = taskDb.getTask(db, id).updated_at;
  // Another writer lands between this caller's first look and its write.
  taskDb.updateTaskMetadata(db, id, (metadata) => { metadata.first = 1; });
  taskDb.updateTaskMetadata(db, id, (metadata) => { metadata.second = 2; }, { touch: false, now: 1 });
  const row = taskDb.getTask(db, id);
  assert.equal(row.metadata.first, 1);
  assert.equal(row.metadata.second, 2);
  assert.ok(row.updated_at >= before);
  assert.equal(taskDb.updateTaskMetadata(db, id, () => false).changed, false);
  assert.equal(taskDb.updateTaskMetadata(db, 'missing-id', () => {}), null);
  const saved = taskDb.setTaskResult(db, { id, actor: 'person', result: 'The page loads in one second.' });
  assert.equal(saved.saved, true);
  const finalRow = taskDb.getTask(db, id);
  assert.equal(finalRow.metadata.first, 1);
  assert.equal(finalRow.metadata.result, 'The page loads in one second.');
});

test('a hand claim with no lease is let go after a long silence, not before', () => {
  const db = taskDb.open();
  const recent = claimedTask(db, 'Recent hand claim', 'person');
  const stale = claimedTask(db, 'Forgotten hand claim', 'person');
  const now = Date.now();
  const dayMs = 86400000;
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(now - 3 * dayMs, recent);
  db.prepare('UPDATE task_events SET created_at = ? WHERE task_id = ?').run(now - (taskDb.UNLEASED_CLAIM_STALE_DAYS + 1) * dayMs, stale);
  const expired = taskDb.expireLeases(db, { now, isAlive: () => false });
  const ids = expired.map((item) => item.id);
  assert.ok(ids.includes(stale));
  assert.ok(!ids.includes(recent));
  assert.equal(taskDb.getTask(db, stale).status, 'open');
  assert.equal(taskDb.getTask(db, recent).status, 'claimed');
  assert.match(expired.find((item) => item.id === stale).reason, /no activity for over 30 days/);
});

test('rendering a TODO imports a hand-added bullet instead of dropping it', () => {
  const db = taskDb.open();
  const todo = path.join(WORKSPACE, 'atris', 'TODO.md');
  taskDb.addTask(db, { title: 'A job from the database', workspaceRoot: ws });
  assert.equal(taskCmd.autoRenderTodoFromDb(WORKSPACE), todo);
  const rendered = fs.readFileSync(todo, 'utf8');
  assert.match(rendered, /Regenerated from durable Atris task state/);
  fs.writeFileSync(todo, rendered.replace('## Backlog\n', '## Backlog\n\n- **Onboard:** Call the first customer: book the call [execute]\n'));
  taskCmd.autoRenderTodoFromDb(WORKSPACE);
  const again = fs.readFileSync(todo, 'utf8');
  assert.match(again, /Call the first customer: book the call/);
  const imported = taskDb.listTasks(db, { workspaceRoot: ws, limit: null })
    .filter((row) => row.title === 'Call the first customer: book the call');
  assert.equal(imported.length, 1);
  assert.equal(imported[0].status, 'open');
  // A second render neither duplicates nor drops it.
  taskCmd.autoRenderTodoFromDb(WORKSPACE);
  assert.equal(taskDb.listTasks(db, { workspaceRoot: ws, limit: null })
    .filter((row) => row.title === 'Call the first customer: book the call').length, 1);
  assert.match(fs.readFileSync(todo, 'utf8'), /Call the first customer: book the call/);
});

test('autopilot finishes the job behind a rendered TODO bullet, and says so only when one matched', () => {
  const { markTodoBulletDone } = require('../commands/autopilot');
  const db = taskDb.open();
  const { id } = taskDb.addTask(db, { title: 'Wire the boundary detector for autopilot', workspaceRoot: ws });
  taskCmd.autoRenderTodoFromDb(WORKSPACE);
  assert.equal(markTodoBulletDone(WORKSPACE, 'Wire the boundary detector for autopilot'), true);
  assert.equal(taskDb.getTask(db, id).status, 'done');
  assert.equal(events(db, id, 'completed').length, 1);
  assert.match(fs.readFileSync(path.join(WORKSPACE, 'atris', 'TODO.md'), 'utf8'), /## Completed[\s\S]*Wire the boundary detector/);
  assert.equal(markTodoBulletDone(WORKSPACE, 'Wire the boundary detector for autopilot'), false, 'a done job is not done twice');
  assert.equal(markTodoBulletDone(WORKSPACE, 'A task nobody wrote down anywhere'), false);
});

test('the projection and TODO are written whole, with no temp files left behind', () => {
  const db = taskDb.open();
  const { outPath } = taskCmd.writeDefaultProjection(taskDb, db, { root: WORKSPACE });
  const projection = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(Array.isArray(projection.tasks));
  const missionCore = require('../lib/mission-core');
  const missionOut = missionCore.writeMissionTaskProjection(taskDb, db, ws);
  assert.equal(path.resolve(missionOut.outPath), path.resolve(outPath));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(outPath, 'utf8'))).sort(), Object.keys(projection).sort(),
    'mission writes the same shape as atris task');
  for (const dir of [path.dirname(outPath), path.join(WORKSPACE, 'atris')]) {
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  }
  const file = path.join(tmpRoot, 'atomic', 'out.txt');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['out.txt']);
});

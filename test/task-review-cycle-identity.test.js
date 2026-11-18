'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tasks = require('../lib/task-db');
const { withTaskReadyResult } = require('./helpers/task-result');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-cycle-'));
  const ws = path.join(dir, 'workspace');
  const file = path.join(dir, 'tasks.db');
  fs.mkdirSync(path.join(ws, 'atris'), { recursive: true });
  const db = tasks.open(file);
  t.after(() => { tasks.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, ws, file, db };
}

function ready(db, id, actor, proof = 'Synthetic proof') {
  return tasks.readyTask(db, { id, actor, proof });
}
function review(db, id, actor) {
  return tasks.reviewTask(db, { id, actor, reward: 0 });
}
function cli(f, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/atris.js'), ...withTaskReadyResult(args)], {
    cwd: f.ws,
    env: { ...process.env, HOME: f.dir, ATRIS_TASKS_DB: f.file, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_AGENT_PROOF_ONLY: '0', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
function task(f, extra = {}) {
  return tasks.addTask(f.db, { title: 'Synthetic review cycle', workspaceRoot: f.ws, ...extra });
}
function certify(f, item, actor = 'builder', reviewer = 'old-reviewer') {
  assert.equal(tasks.claimTask(f.db, { id: item.id, claimedBy: actor }).claimed, true);
  assert.equal(ready(f.db, item.id, actor).ready, true);
  assert.equal(review(f.db, item.id, reviewer).reviewed, true);
  assert.equal(tasks.getTask(f.db, item.id).metadata.agent_certified, true);
}
function identityAbsent(metadata) {
  for (const field of ['built_by', 'agent_review_actors', 'independent_review_by']) {
    assert.equal(Object.hasOwn(metadata, field), false, field);
  }
}

test('CLI revision retains history but repeated builder passes cannot reuse its old reviewer', t => {
  const f = fixture(t), item = task(f);
  certify(f, item);
  const before = tasks.listTaskEvents(f.db, { taskId: item.id });
  cli(f, ['task', 'revise', item.id, '--note', 'Please revise this', '--as', 'owner']);
  const revised = tasks.getTask(f.db, item.id);
  identityAbsent(revised.metadata);
  const after = tasks.listTaskEvents(f.db, { taskId: item.id });
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.at(-1).event_type, 'revision_requested');
  fs.writeFileSync(path.join(f.ws, 'proof.txt'), 'Synthetic revised work');
  cli(f, ['task', 'ready', item.id, '--proof', 'Synthetic artifact ./proof.txt', '--as', 'builder']);
  cli(f, ['task', 'ready', item.id, '--proof', 'Synthetic artifact ./proof.txt', '--as', 'builder']);
  const current = tasks.getTask(f.db, item.id).metadata;
  assert.equal(current.built_by, 'builder');
  assert.deepEqual(current.agent_review_actors, ['builder']);
  assert.notEqual(current.agent_certified, true);
  assert.equal(current.independent_review_by, undefined);
  assert.equal(review(f.db, item.id, 'new-reviewer').reviewed, true);
  assert.equal(tasks.getTask(f.db, item.id).metadata.independent_review_by, 'new-reviewer');
  assert.equal(tasks.getTask(f.db, item.id).metadata.agent_certified, true);
});

test('reopen removes prior identity before a different claimant begins new work', t => {
  const f = fixture(t);
  const done = task(f, { metadata: { keep: 'value' } });
  certify(f, done, 'old-builder');
  assert.equal(tasks.doneTask(f.db, { id: done.id, actor: 'owner', allowReview: true }).updated, true);
  const history = tasks.listTaskEvents(f.db, { taskId: done.id });
  const reopened = tasks.reopenTask(f.db, { id: done.id, actor: 'owner' });
  assert.equal(reopened.reopened, true);
  identityAbsent(reopened.row.metadata);
  assert.equal(reopened.row.metadata.keep, 'value');
  assert.deepEqual(tasks.listTaskEvents(f.db, { taskId: done.id }).slice(0, history.length), history);
  assert.equal(tasks.claimTask(f.db, { id: done.id, claimedBy: 'new-builder' }).claimed, true);
  ready(f.db, done.id, 'new-builder');
  ready(f.db, done.id, 'new-builder');
  const current = tasks.getTask(f.db, done.id).metadata;
  assert.equal(current.built_by, 'new-builder');
  assert.deepEqual(current.agent_review_actors, ['new-builder']);
  assert.notEqual(current.agent_certified, true);
});

test('repeated first proof actor alone does not create independent review', t => {
  const f = fixture(t), item = task(f);
  tasks.claimTask(f.db, { id: item.id, claimedBy: ' Actual Builder ' });
  ready(f.db, item.id, 'reviewer');
  ready(f.db, item.id, 'reviewer');
  const result = tasks.getTask(f.db, item.id).metadata;
  assert.equal(result.built_by, 'reviewer');
  assert.deepEqual(result.agent_review_actors, ['reviewer']);
  assert.equal(result.independent_review_by, undefined);
  assert.notEqual(result.agent_certified, true);
});

test('missing actor is not invented when no environment actor or claimant exists', t => {
  const f = fixture(t), item = task(f);
  const savedAgent = process.env.ATRIS_AGENT_ID, savedUser = process.env.USER;
  try {
    delete process.env.ATRIS_AGENT_ID;
    delete process.env.USER;
    ready(f.db, item.id, null);
    ready(f.db, item.id, null);
    const metadata = tasks.getTask(f.db, item.id).metadata;
    assert.equal(metadata.built_by, undefined);
    assert.deepEqual(metadata.agent_review_actors, []);
    assert.notEqual(metadata.agent_certified, true);
    assert.equal(metadata.independent_review_by, undefined);
  } finally {
    if (savedAgent === undefined) delete process.env.ATRIS_AGENT_ID; else process.env.ATRIS_AGENT_ID = savedAgent;
    if (savedUser === undefined) delete process.env.USER; else process.env.USER = savedUser;
  }
});

test('failed revision event rolls back identity reset along with the task row', t => {
  const f = fixture(t), item = task(f);
  certify(f, item);
  const before = tasks.getTask(f.db, item.id);
  const events = tasks.listTaskEvents(f.db, { taskId: item.id });
  f.db.exec("CREATE TRIGGER fixture_reject_revision BEFORE INSERT ON task_events WHEN NEW.event_type = 'revision_requested' BEGIN SELECT RAISE(ABORT, 'fixture reject'); END");
  assert.throws(() => tasks.reviseTask(f.db, { id: item.id, actor: 'owner', note: 'Revise' }), /fixture reject/);
  assert.deepEqual(tasks.getTask(f.db, item.id), before);
  assert.deepEqual(tasks.listTaskEvents(f.db, { taskId: item.id }), events);
});

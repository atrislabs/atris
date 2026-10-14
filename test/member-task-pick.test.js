'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const taskDb = require('../lib/task-db');
const { claimTaskForMember, jobForTask, pickTaskForMember, taskObjective } = require('../lib/member-task-pick');

function withProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-pick-'));
  taskDb.close();
  const db = taskDb.open(path.join(dir, 'tasks.db'));
  const ws = taskDb.workspaceRoot(dir);
  let clock = 1000;
  const add = (title, opts = {}) => {
    const { id } = taskDb.addTask(db, { title, workspaceRoot: ws, ...opts });
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(clock += 1000, id);
    return id;
  };
  try {
    fn({ db, ws, add });
  } finally {
    taskDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('picks the oldest open build task and claims it for the member', () => {
  withProject(({ db, ws, add }) => {
    const oldest = add('Fix the flaky clock test', { metadata: { objective: 'The clock test fails one run in five.' } });
    add('Add a retry to the uploader');
    const got = claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' });
    assert.equal(got.task.id, oldest);
    assert.equal(got.task.status, 'claimed');
    assert.equal(got.task.claimed_by, 'executor');
    assert.equal(got.objective, 'Fix the flaky clock test. The clock test fails one run in five.');
    assert.equal(taskDb.getTask(db, oldest).claimed_by, 'executor');
  });
});

test('skips needs-human, claimed, and billing tasks', () => {
  withProject(({ db, ws, add }) => {
    add('Pick the launch price', { tag: 'needs-human' });
    add('Decide the copy', { metadata: { tags: ['needs-human'] } });
    add('Already being built', { status: 'claimed', claimedBy: 'someone' });
    add('Refund the duplicate charge', { tag: 'billing' });
    const fits = add('Rename the stale flag');
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' }).id, fits);
  });
});

test('matches the member job: review and search tasks go to their members', () => {
  withProject(({ db, ws, add }) => {
    const build = add('Wire the new flag');
    const review = add('Review the uploader change', { tag: 'review' });
    const search = add('Research how other tools page results');
    assert.equal(jobForTask({ title: 'Review the uploader change' }), 'review');
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'review' }).id, review);
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'search' }).id, search);
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' }).id, build);
  });
});

test('returns null when nothing fits so the caller falls back', () => {
  withProject(({ db, ws, add }) => {
    assert.equal(claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' }), null);
    add('Ship the invoice email', { tag: 'payments' });
    add('Hold for owner', { tag: 'needs-human' });
    assert.equal(claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' }), null);
  });
});

test('objective is just the title when the task has no body', () => {
  assert.equal(taskObjective({ title: 'Rename the flag', metadata: {} }), 'Rename the flag');
});

test('objective with a body stays on one line so mission start accepts it', () => {
  const objective = taskObjective({
    title: 'Read README.md and report the documented upload retry policy',
    metadata: { body: 'Confirm uploads retry three times\nbefore reporting failure.' },
  });
  assert.equal(objective, 'Read README.md and report the documented upload retry policy. Confirm uploads retry three times before reporting failure.');
  assert.doesNotMatch(objective, /[\n\r]/);
});

test('skips tasks protected by a declared phrase in the body or a denied tag in metadata', () => {
  withProject(({ db, ws, add }) => {
    add('Tune the landing gate', { metadata: { objective: 'Protected lane: a human accepts this one.' } });
    add('Rotate the shared token', { metadata: { tags: ['security'] } });
    add('Wire the stripe webhook');
    const ok = add('Add a retry to the uploader');
    const got = claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' });
    assert.equal(got.task.id, ok);
  });
});

test('a claim that throws is released, not stranded', () => {
  withProject(({ db, ws, add }) => {
    const id = add('Add a retry to the uploader');
    const failing = {
      ...taskDb,
      claimTask: (d, args) => { taskDb.claimTask(d, args); throw new Error('event write failed'); },
    };
    assert.throws(() => claimTaskForMember(failing, db, { workspaceRoot: ws, member: 'executor', job: 'build' }), /event write failed/);
    const row = taskDb.getTask(db, id);
    assert.equal(row.claimed_by, null);
    assert.equal(row.status, 'open');
  });
});

test('skips a protected note in any text field and a denied tag written in the title', () => {
  withProject(({ db, ws, add }) => {
    add('Tidy the upload copy', { metadata: { objective: 'Shorter wording.', details: 'Protected lane: a human accepts this one.' } });
    add('Rotate keys #security');
    const ok = add('Add a retry to the uploader');
    const got = claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' });
    assert.equal(got.task.id, ok);
  });
});

test('skips needs-human and decision tags written in metadata', () => {
  withProject(({ db, ws, add }) => {
    add('Pick the pricing copy', { metadata: { tag: 'needs-human' } });
    add('Choose the launch date', { metadata: { tags: ['decision'] } });
    const ok = add('Add a retry to the uploader');
    const got = claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' });
    assert.equal(got.task.id, ok);
  });
});

test('skips a task whose required check is prose that cannot be run', () => {
  withProject(({ db, ws, add }) => {
    add('Polish the docs', { metadata: { verify: 'looks good to a reader' } });
    const ok = add('Add a retry to the uploader', { metadata: { verify: 'node --test test/upload.test.js' } });
    const got = claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build' });
    assert.equal(got.task.id, ok);
  });
});

test('requireCheck skips tasks with no check or a prose check, and finds nothing when none has one', () => {
  withProject(({ db, ws, add }) => {
    add('Tidy the readme');
    add('Polish the docs', { metadata: { verify: 'looks good to a reader' } });
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build', requireCheck: true }), null);
    assert.equal(claimTaskForMember(taskDb, db, { workspaceRoot: ws, member: 'executor', job: 'build', requireCheck: true }), null);
    const ok = add('Add a retry to the uploader', { metadata: { verify: 'node --test test/upload.test.js' } });
    assert.equal(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build', requireCheck: true }).id, ok);
    assert.notEqual(pickTaskForMember(taskDb, db, { workspaceRoot: ws, job: 'build' }).id, ok, 'without the flag a task with no check still fits');
  });
});

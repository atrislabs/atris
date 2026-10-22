'use strict';

// When the job list is empty, a member writes its own next job from its
// mission and keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const { MAX_PER_DAY, missionNextJob, writeSelfNextJob } = require('../lib/member-self-next-job');
const { createMemberUp } = require('../lib/member-up');
const { fittingTasks } = require('../lib/member-task-pick');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

const MISSION = [
  '# Executor Mission',
  '',
  '## North Star',
  '',
  'Every build spec lands as a small verified diff.',
  '',
  '## What I Do',
  '',
  '1. Build one slice',
  '',
  '## Check',
  '',
  '`node --test test/smoke.test.js`',
  '',
].join('\n');

function withProject(fn, mission = MISSION) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-next-'));
  const dbPath = path.join(root, 'tasks.db');
  const taskDb = require('../lib/task-db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  const workspaceRoot = taskDb.workspaceRoot(root);
  const dir = path.join(root, 'atris', 'team', 'executor');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: executor\nrole: Builder\n---\n# executor\n');
  if (mission != null) fs.writeFileSync(path.join(dir, 'MISSION.md'), mission);
  const write = (opts = {}) => writeSelfNextJob(taskDb, db, { root, workspaceRoot, member: 'executor', job: 'build', ...opts });
  try {
    fn({ root, db, taskDb, workspaceRoot, write, env: { ATRIS_TASKS_DB: dbPath } });
  } finally {
    taskDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a mission with a north star and a check becomes a next job', () => {
  assert.deepEqual(missionNextJob(MISSION), {
    title: 'next step toward: Every build spec lands as a small verified diff.',
    objective: 'Every build spec lands as a small verified diff.',
    check: 'node --test test/smoke.test.js',
  });
  assert.equal(missionNextJob(MISSION.replace(/## Check[\s\S]*$/, '')), null);
  assert.equal(missionNextJob('# nothing here\n'), null);
});

test('an empty list gets one self-written job the member can take', () => {
  withProject(({ db, taskDb, workspaceRoot, write }) => {
    assert.equal(fittingTasks(taskDb, db, { workspaceRoot, job: 'build', requireCheck: true }).length, 0);
    const { task } = write();
    assert.equal(task.status, 'open');
    assert.equal(task.tag, 'build');
    assert.equal(task.metadata.verify, 'node --test test/smoke.test.js');
    assert.equal(task.metadata.written_by, 'executor');
    const fits = fittingTasks(taskDb, db, { workspaceRoot, member: 'executor', job: 'build', requireCheck: true });
    assert.deepEqual(fits.map((t) => t.id), [task.id]);

    // One open at a time.
    assert.match(write().skip, /still open/);
    // Done frees the seat, so it keeps working.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    assert.ok(write().task.id);
  });
});

// 2026-10-22: atris-cli had 15 "next step toward" jobs in review at once,
// because a job waiting for review freed the member to write the next one.
test('a self-written job waiting for review still holds the member\'s one seat', () => {
  withProject(({ db, write }) => {
    const { task } = write();
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(task.id);
    assert.match(write().skip, /waiting for review/);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    assert.ok(write().task.id);
  });
});

test('a member writes at most a few jobs for itself per day', () => {
  withProject(({ db, write }) => {
    for (let i = 0; i < MAX_PER_DAY; i += 1) {
      const { task } = write();
      assert.ok(task && task.id, `write ${i + 1}`);
      db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
    }
    assert.match(write().skip, /today/);
    assert.ok(write({ now: Date.now() + 24 * 60 * 60 * 1000 }).task.id);
  });
});

test('no mission, no check, or a dry run writes nothing', () => {
  withProject(({ write }) => assert.match(write().skip, /no mission/), null);
  withProject(({ write }) => assert.match(write().skip, /no check/), MISSION.replace(/## Check[\s\S]*$/, ''));
  withProject(({ db, write }) => {
    const { task } = write({ dryRun: true });
    assert.equal(task.id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  });
});

test('the supervisor starts a member on its self-written job instead of going idle', () => {
  const lines = [];
  const spawned = [];
  const up = createMemberUp({
    listMembers: () => [{ name: 'executor' }],
    pickTask: () => null,
    writeNextJob: () => ({ task: { id: 't1', title: 'next step toward: ship', metadata: { verify: 'node --test test/a.test.js' } } }),
    spawn: (name) => spawned.push(name),
    now: () => 0,
    print: (line) => lines.push(line),
  });
  assert.deepEqual(up.check().map((s) => s.name), ['executor']);
  assert.deepEqual(spawned, ['executor']);
  assert.ok(lines.includes('executor had no job, so it wrote its own from its mission: next step toward: ship'));
  assert.deepEqual(up.idle(), []);

  const quiet = createMemberUp({
    listMembers: () => [{ name: 'executor' }],
    pickTask: () => null,
    writeNextJob: () => ({ skip: 'mission names no north star or no check' }),
    spawn: () => assert.fail('must not start'),
    now: () => 0,
    print: () => {},
  });
  assert.deepEqual(quiet.check(), []);
  assert.deepEqual(quiet.idle(), ['executor']);
});

test('atris member up --dry-run shows the job a member would write for itself', () => {
  withProject(({ root, db, env }) => {
    const result = spawnSync(process.execPath, [cliPath, 'member', 'up', '--dry-run', '--only', 'executor'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /executor had no job, so it would write its own from its mission: next step toward: Every build spec/);
    assert.match(result.stdout, /would start executor on: next step toward:/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  });
});

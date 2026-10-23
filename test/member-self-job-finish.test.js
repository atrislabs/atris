'use strict';

// A member's self-written job ("next step toward: <goal>") moves to review
// only when the run changed something: a new commit in its work copy, a
// pushed branch, or a pull request. A run that passed its check and changed
// nothing goes back on the list with a plain note. On 2026-10-22, 13 of the
// 22 atris-cli review jobs had finished on the commit they started from.
// Real git work copy, real job database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');

function git(cwd, ...args) {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
}

function withProject(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-finish-')));
  fs.mkdirSync(path.join(root, 'atris'));
  git(root, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const copy = path.join(root, 'work-copy');
  git(root, 'worktree', 'add', '-q', '-b', 'member-work', copy);
  const dbPath = path.join(root, 'tasks.db');
  taskDb.close();
  const db = taskDb.open(dbPath);
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  // A self-written job, claimed from the main folder so its start commit is
  // the main branch, the way member go claims it.
  const selfJob = (n = 1) => {
    const id = taskDb.addTask(db, {
      title: 'next step toward: Members work for hours without a person stepping in.',
      tag: 'build', workspaceRoot: root, sourceKey: `self-next:executor:2026-10-22:${n}`,
      metadata: { verify: 'node --version', written_by: 'executor', source: 'member mission' },
    }).id;
    assert.equal(taskDb.claimTask(db, { id, claimedBy: 'executor' }).claimed, true);
    return taskDb.getTask(db, id);
  };
  const passed = (extra = {}) => ({
    started: true, mission_id: 'm-1', worktree: { path: copy },
    mission: { status: 'complete', verifier_result: { passed: true, command: 'node --version' }, worktree: { path: copy } },
    ...extra,
  });
  try {
    fn({ root, copy, db, selfJob, passed });
  } finally {
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = saved;
    taskDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a self-written job whose run changed nothing goes back on the list with a plain note', () => {
  const { memberGoFinishTask } = require('../commands/member');
  withProject(({ db, selfJob, passed }) => {
    const job = selfJob();
    const out = memberGoFinishTask('executor', job, passed());
    assert.equal(out.outcome, 'released');
    assert.match(out.reason, /changed nothing/);
    const row = taskDb.getTask(db, job.id);
    assert.equal(row.status, 'open');
    const notes = taskDb.listTaskEvents(db, { taskId: job.id }).map((e) => String(e.payload?.content || ''));
    assert.ok(notes.some((n) => /changed nothing/.test(n)), notes.join('\n'));
  });
});

test('a self-written job whose run made a commit moves to review', () => {
  const { memberGoFinishTask } = require('../commands/member');
  withProject(({ copy, db, selfJob, passed }) => {
    const job = selfJob();
    fs.writeFileSync(path.join(copy, 'fix.js'), 'module.exports = 1;\n');
    git(copy, 'add', '.');
    git(copy, 'commit', '-q', '-m', 'member work');
    assert.equal(memberGoFinishTask('executor', job, passed()).outcome, 'review');
    assert.equal(taskDb.getTask(db, job.id).status, 'review');
  });
});

test('a self-written job whose run pushed a pull request moves to review', () => {
  const { memberGoFinishTask } = require('../commands/member');
  withProject(({ db, selfJob, passed }) => {
    const job = selfJob();
    const out = memberGoFinishTask('executor', job, passed({ autoland: { auto_merge: true, url: 'https://github.com/acme/repo/pull/7', pushed: 'a'.repeat(40) } }));
    assert.equal(out.outcome, 'review');
    assert.equal(taskDb.getTask(db, job.id).status, 'review');
  });
});

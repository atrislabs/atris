'use strict';

// Time simulations for the pile-up we cleared by hand. Each morning the list
// keeps itself. Finished work and work that sits past its window must leave,
// and fresh work must stay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskStore = require('../lib/task-db');
const { DAY_MS, IDLE_LIMITS_MS, keepTaskList } = require('../lib/task-list-keeper');
const { taskDayGroups } = require('../commands/task');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-sim-')));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  return root;
}

function cleanupWorkspace(root) {
  taskStore.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function runCli(args, { cwd, env }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function stamp(db, id, when) {
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(when, when, id);
}

function add(db, root, { title, status = 'open', when, tag, metadata, claimedBy }) {
  const created = taskStore.addTask(db, {
    title,
    workspaceRoot: root,
    status,
    tag,
    metadata,
    claimedBy,
  });
  if (when != null) stamp(db, created.id, when);
  return created.id;
}

function ageOf(row, now) {
  return now - Number(row.updated_at || row.created_at || 0);
}

function assertListIsLawful(rows, now, label) {
  const visible = { open: 0, claimed: 0, review: 0, failed: 0, done: 0 };
  for (const row of rows) {
    if (row.status === 'archived') continue;
    const age = ageOf(row, now);
    if (row.status === 'done') {
      assert.fail(`${label}: finished work is still on the list (${row.title})`);
    }
    const limit = IDLE_LIMITS_MS[row.status];
    if (limit != null && age > limit) {
      assert.fail(`${label}: ${row.status} work sat ${age}ms, past ${limit}ms (${row.title})`);
    }
    if (Object.prototype.hasOwnProperty.call(visible, row.status)) visible[row.status] += 1;
  }
  return visible;
}

test('ninety mornings of new work never let the list pile up', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const start = Date.UTC(2026, 0, 1);
  const days = 90;
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const keptAlive = add(db, root, { title: 'kept alive', when: start });
    let maxOpen = 0;
    let finishedSeen = 0;
    for (let day = 0; day < days; day += 1) {
      const now = start + (day * DAY_MS);
      add(db, root, { title: `open ${day}`, when: now });
      add(db, root, { title: `claimed ${day}`, status: 'claimed', claimedBy: 'worker', when: now });
      add(db, root, { title: `review ${day}`, status: 'review', claimedBy: 'worker', when: now });
      add(db, root, { title: `failed ${day}`, status: 'failed', when: now });
      add(db, root, { title: `done ${day}`, status: 'done', when: now });
      stamp(db, keptAlive, now);
      const kept = keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [] });
      finishedSeen += kept.put_away.filter(row => row.previous_status === 'done').length;
      const rows = taskStore.listTasks(db, { workspaceRoot: root, limit: null });
      const visible = assertListIsLawful(rows, now, `day ${day}`);
      maxOpen = Math.max(maxOpen, visible.open);
      assert.equal(visible.done, 0);
      assert.ok(visible.claimed <= 4, `day ${day}: ${visible.claimed} claimed`);
      assert.ok(visible.review <= 15, `day ${day}: ${visible.review} in review`);
      assert.ok(visible.failed <= 31, `day ${day}: ${visible.failed} failed`);
      assert.equal(taskStore.getTask(db, keptAlive).status, 'open');
    }
    assert.equal(finishedSeen, days);
    assert.ok(maxOpen <= 16, `open work grew to ${maxOpen}`);
    assert.equal(taskStore.getTask(db, keptAlive).status, 'open');
  } finally {
    cleanupWorkspace(root);
  }
});

test('a stopped mission leaves during the week even when the blocker is young', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const start = Date.UTC(2026, 2, 1);
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const blocker = add(db, root, {
      title: 'unblock the stopped mission',
      when: start,
      tag: 'mission-blocker',
      metadata: { mission_id: 'mission-sim', mission_blocker_class: 'runner-failed' },
    });
    const stillRunning = keepTaskList(db, {
      workspaceRoot: root,
      actor: 'tester',
      now: start + (2 * DAY_MS),
      missions: [{ id: 'mission-sim', status: 'active' }],
    });
    assert.equal(stillRunning.reaped.length, 0);
    assert.equal(taskStore.getTask(db, blocker).status, 'open');

    const stopped = keepTaskList(db, {
      workspaceRoot: root,
      actor: 'tester',
      now: start + (2 * DAY_MS),
      missions: [{ id: 'mission-sim', status: 'stopped' }],
    });
    assert.equal(stopped.reaped.length, 1);
    assert.equal(taskStore.getTask(db, blocker).status, 'archived');
  } finally {
    cleanupWorkspace(root);
  }
});

test('mixed ages after one keep match the windows, including the exact edge', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const now = Date.UTC(2026, 5, 1);
  try {
    const db = taskStore.open(path.join(root, 'tasks.db'));
    const samples = [
      ['open edge', 'open', IDLE_LIMITS_MS.open, 'open'],
      ['open over', 'open', IDLE_LIMITS_MS.open + 1, 'archived'],
      ['claim edge', 'claimed', IDLE_LIMITS_MS.claimed, 'claimed'],
      ['claim over', 'claimed', IDLE_LIMITS_MS.claimed + 1, 'archived'],
      ['review edge', 'review', IDLE_LIMITS_MS.review, 'review'],
      ['review over', 'review', IDLE_LIMITS_MS.review + 1, 'archived'],
      ['fail edge', 'failed', IDLE_LIMITS_MS.failed, 'failed'],
      ['fail over', 'failed', IDLE_LIMITS_MS.failed + 1, 'archived'],
      ['finished now', 'done', 0, 'archived'],
    ];
    const ids = new Map();
    for (const [title, status, age] of samples) {
      ids.set(title, add(db, root, {
        title,
        status,
        when: now - age,
        claimedBy: status === 'claimed' || status === 'review' ? 'worker' : undefined,
      }));
    }
    keepTaskList(db, { workspaceRoot: root, actor: 'tester', now, missions: [] });
    for (const [title, , , expected] of samples) {
      assert.equal(taskStore.getTask(db, ids.get(title)).status, expected, title);
    }
    const rows = taskStore.listTasks(db, { workspaceRoot: root, limit: null });
    assertListIsLawful(rows, now, 'mixed ages');

    const shown = taskDayGroups(rows.map(row => ({ ...row, display_id: row.id })), { now })
      .groups.flatMap(group => group.tasks.map(task => task.title));
    assert.deepEqual(shown.filter(title => title.includes('over') || title === 'finished now'), []);
    assert.ok(shown.includes('open edge'));
  } finally {
    cleanupWorkspace(root);
  }
});

test('the original pile is gone from the screen after one open', () => {
  if (!hasNodeSqlite()) return;
  const root = makeWorkspace();
  const dbPath = path.join(root, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath };
  const now = Date.now();
  try {
    const db = taskStore.open(dbPath);
    const pile = [
      ['oldpile done', 'done', 149, 2],
      ['oldpile open', 'open', 45, 20],
      ['oldpile claimed', 'claimed', 23, 10],
      ['oldpile review', 'review', 17, 20],
      ['oldpile failed', 'failed', 2, 40],
    ];
    for (const [title, status, count, days] of pile) {
      for (let index = 0; index < count; index += 1) {
        add(db, root, {
          title: `${title} ${index}`,
          status,
          when: now - (days * DAY_MS) - 1000,
          claimedBy: status === 'claimed' || status === 'review' ? 'worker' : undefined,
        });
      }
    }
    add(db, root, { title: 'live waiting task', when: now });
    add(db, root, { title: 'live moving task', status: 'claimed', claimedBy: 'worker', when: now });
    taskStore.close();

    const boot = runCli(['atris.md'], { cwd: root, env });
    assert.equal(boot.status, 0, boot.stderr);
    assert.match(boot.stdout, /put away 236 items/);
    assert.match(boot.stdout, /live moving task/);
    assert.match(boot.stdout, /1 waiting to start/);
    assert.doesNotMatch(boot.stdout, /oldpile/);
    assert.doesNotMatch(boot.stdout, /getting a final look/);

    const day = runCli(['task', 'day'], { cwd: root, env });
    assert.equal(day.status, 0, day.stderr);
    assert.match(day.stdout, /live waiting task/);
    assert.match(day.stdout, /live moving task/);
    assert.doesNotMatch(day.stdout, /oldpile/);
    assert.match(day.stdout, /active 2 \/ owners 2/);

    const todo = fs.readFileSync(path.join(root, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /live waiting task/);
    assert.doesNotMatch(todo, /oldpile/);

    const check = taskStore.open(dbPath);
    const rows = taskStore.listTasks(check, { workspaceRoot: root, limit: null });
    const visible = assertListIsLawful(rows, Date.now(), 'after open');
    assert.equal(visible.open, 1);
    assert.equal(visible.claimed, 1);
    assert.equal(visible.review, 0);
    assert.equal(visible.failed, 0);
    assert.equal(rows.filter(row => row.status === 'archived').length, 236);
  } finally {
    cleanupWorkspace(root);
  }
});

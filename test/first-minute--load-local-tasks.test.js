const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadLocalTasks, loadLocalTaskState } = require('../lib/first-minute');
const taskDb = require('../lib/task-db');
const { runCli } = require('./helpers/task-next-fixture');

// Point HOME at a throwaway folder and clear every ATRIS_* override, so the
// task db and any state lookup stay inside the temp tree on any machine.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'first-minute-load-home-'));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.env.HOME = home;

after(() => {
  taskDb.close();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

function setupRoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-minute-load-'));
  const root = path.join(dir, 'room');
  // atris/atris.md pins the workspace root to this folder, not an ancestor.
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# protocol\n');
  const dbPath = path.join(dir, 'tasks.db');
  process.env.ATRIS_TASKS_DB = dbPath;
  return { dir, root, dbPath };
}

function writeProjection(root, body) {
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

function addDbTask(dbPath, root, { title, status }) {
  const db = taskDb.open(dbPath);
  return taskDb.addTask(db, {
    title,
    status,
    workspaceRoot: taskDb.workspaceRoot(root),
  });
}

test('reads the task db rows for this folder, open work first', () => {
  const ctx = setupRoom();
  try {
    addDbTask(ctx.dbPath, ctx.root, { title: 'write the intro', status: 'done' });
    addDbTask(ctx.dbPath, ctx.root, { title: 'ship the landing page', status: 'open' });

    const tasks = loadLocalTasks(ctx.root);

    assert.deepStrictEqual(
      tasks.map((task) => [task.title, task.status]),
      [['ship the landing page', 'open'], ['write the intro', 'done']],
    );
    assert.ok(tasks.every((task) => typeof task.display_id === 'string' && task.display_id.length > 0));
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('now and next keep the full workspace reference and open the same task after history is clipped', () => {
  const ctx = setupRoom();
  try {
    const db = taskDb.open(ctx.dbPath);
    const workspaceRoot = taskDb.workspaceRoot(ctx.root);
    for (let i = 0; i < 205; i++) {
      const old = taskDb.addTask(db, { workspaceRoot, title: `Old task ${i}`, status: 'archived' });
      db.prepare("UPDATE tasks SET status = 'archived', created_at = ? WHERE id = ?").run(i + 1, old.id);
    }
    const current = taskDb.addTask(db, {
      workspaceRoot, title: 'The current reviewed change', status: 'review',
      metadata: { agent_certified: true, agent_review_pass_count: 2 },
    });
    const env = { HOME: home, ATRIS_TASKS_DB: ctx.dbPath };
    const cli = (args) => {
      const result = runCli(args, { cwd: ctx.root, env });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const canonical = cli(['task', 'next', '--json']);
    assert.strictEqual(canonical.task_id, current.id);
    const now = cli(['now', '--json']);
    const next = cli(['next', '--json']);
    assert.strictEqual(now.next, canonical.command);
    assert.strictEqual(next.next_action, canonical.command);
    const suggestedRef = now.next.split(/\s+/).pop();
    assert.strictEqual(cli(['task', 'show', suggestedRef, '--json']).id, current.id);
    assert.strictEqual(taskDb.getTask(db, current.id).status, 'review');
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('exact bound lookups use full workspace references even outside the visible window', () => {
  const ctx = setupRoom();
  try {
    const db = taskDb.open(ctx.dbPath);
    const workspaceRoot = taskDb.workspaceRoot(ctx.root);
    const old = taskDb.addTask(db, { workspaceRoot, title: 'Old history', status: 'archived' });
    db.prepare("UPDATE tasks SET status = 'archived', created_at = 1 WHERE id = ?").run(old.id);
    const bound = taskDb.addTask(db, { workspaceRoot, title: 'Bound job', status: 'claimed', claimedBy: 'builder' });
    db.prepare('UPDATE tasks SET created_at = 2 WHERE id = ?').run(bound.id);
    for (let i = 0; i < 201; i++) {
      const open = taskDb.addTask(db, { workspaceRoot, title: `Open job ${i}`, status: 'open' });
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(i + 3, open.id);
    }
    const expected = taskDb.taskProjection(db, { workspaceRoot, taskId: bound.id }).tasks[0];
    const actual = loadLocalTaskState(ctx.root, { taskIds: [bound.id] }).tasks.find((row) => row.id === bound.id);
    assert.strictEqual(actual.display_id, expected.display_id);
    assert.strictEqual(actual.legacy_ref, expected.legacy_ref);
    assert.strictEqual(actual.claimed_by, 'builder');
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('falls back to the local projection when no task db exists, and writes no db', () => {
  const ctx = setupRoom();
  try {
    const projected = { id: 't-1', title: 'from the projection', status: 'open' };
    writeProjection(ctx.root, { tasks: [projected] });

    const tasks = loadLocalTasks(ctx.root);

    assert.deepStrictEqual(tasks, [projected]);
    assert.strictEqual(fs.existsSync(ctx.dbPath), false);
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('an unknown open projection task is kept alongside done-only db evidence', () => {
  const ctx = setupRoom();
  try {
    addDbTask(ctx.dbPath, ctx.root, { title: 'old win', status: 'done' });
    writeProjection(ctx.root, {
      tasks: [{ id: 't-2', title: 'next up', status: 'open' }],
    });

    const tasks = loadLocalTasks(ctx.root);

    assert.deepStrictEqual(tasks.map((task) => task.title), ['next up', 'old win']);
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('done-only db rows are returned when there is no projection', () => {
  const ctx = setupRoom();
  try {
    addDbTask(ctx.dbPath, ctx.root, { title: 'old win', status: 'done' });

    const tasks = loadLocalTasks(ctx.root);

    assert.deepStrictEqual(
      tasks.map((task) => [task.title, task.status]),
      [['old win', 'done']],
    );
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('returns an empty list for an empty folder, a broken projection, or a missing root', () => {
  const ctx = setupRoom();
  try {
    assert.deepStrictEqual(loadLocalTasks(ctx.root), []);

    writeProjection(ctx.root, '{not json');
    assert.deepStrictEqual(loadLocalTasks(ctx.root), []);

    const missing = path.join(ctx.dir, 'does-not-exist');
    assert.deepStrictEqual(loadLocalTasks(missing), []);
    assert.strictEqual(fs.existsSync(ctx.dbPath), false);
  } finally {
    taskDb.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

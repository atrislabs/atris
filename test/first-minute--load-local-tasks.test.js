const { after, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadLocalTasks } = require('../lib/first-minute');
const taskDb = require('../lib/task-db');

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

test('an open projection task beats done-only db rows', () => {
  const ctx = setupRoom();
  try {
    addDbTask(ctx.dbPath, ctx.root, { title: 'old win', status: 'done' });
    writeProjection(ctx.root, {
      tasks: [{ id: 't-2', title: 'next up', status: 'open' }],
    });

    const tasks = loadLocalTasks(ctx.root);

    assert.deepStrictEqual(tasks.map((task) => task.title), ['next up']);
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

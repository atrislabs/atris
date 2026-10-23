'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// refreshKeptTaskList opens the task database, writes the snapshot under
// ./.atris/state of the process cwd, and re-renders <cwd>/atris/TODO.md.
// Everything below lives in a throwaway sandbox, with the env scrubbed first.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ATRIS_')) delete process.env[name];
}

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refresh-kept-')));
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = path.join(sandbox, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const skip = hasNodeSqlite() ? false : 'node:sqlite is not available on this Node';

const taskStore = require('../lib/task-db');
const { refreshKeptTaskList } = require('../commands/task');

let counter = 0;

// One folder per test: its own task database and its own workspace root.
function makeWorkspace({ withAtrisDir = true } = {}) {
  counter += 1;
  const root = path.join(sandbox, `ws-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  if (withAtrisDir) fs.mkdirSync(path.join(root, 'atris'));
  process.env.ATRIS_TASKS_DB = path.join(sandbox, `db-${counter}`, 'tasks.db');
  process.chdir(root);
  return { root, db: taskStore.open() };
}

function readProjection(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
}

function readTodo(root) {
  return fs.readFileSync(path.join(root, 'atris', 'TODO.md'), 'utf8');
}

// Body of one "## Name" section, up to the next "## " heading.
function section(markdown, name) {
  const match = markdown.match(new RegExp(`(?:^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : null;
}

test.afterEach(() => {
  taskStore.close();
  process.chdir(originalCwd);
});

test.after(() => {
  taskStore.close();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  delete process.env.ATRIS_TASKS_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('refreshKeptTaskList writes the task snapshot and TODO.md for this workspace', { skip }, () => {
  const { root, db } = makeWorkspace();
  taskStore.addTask(db, { title: 'Write the report', workspaceRoot: root });
  taskStore.addTask(db, {
    title: 'Check the numbers',
    workspaceRoot: root,
    status: 'claimed',
    claimedBy: 'worker-one',
  });

  const returned = refreshKeptTaskList(root);
  assert.strictEqual(returned, undefined);

  const projection = readProjection(root);
  assert.strictEqual(projection.schema, 'atris.task_projection.v1');
  assert.strictEqual(projection.workspace_root, root);
  assert.strictEqual(projection.surface.full_task_count, 2);
  const byTitle = Object.fromEntries(projection.tasks.map(task => [task.title, task]));
  assert.deepStrictEqual(Object.keys(byTitle).sort(), ['Check the numbers', 'Write the report']);
  assert.strictEqual(byTitle['Write the report'].status, 'open');
  assert.strictEqual(byTitle['Check the numbers'].status, 'claimed');
  assert.strictEqual(byTitle['Check the numbers'].claimed_by, 'worker-one');

  const todo = readTodo(root);
  assert.match(todo, /^# TODO\.md/);
  assert.match(todo, /Regenerated from durable Atris task state/);
  assert.strictEqual(
    section(todo, 'Backlog'),
    `- **[${byTitle['Write the report'].display_id}]** Write the report`,
  );
  assert.match(section(todo, 'In Progress'), /Check the numbers/);
  assert.match(section(todo, 'In Progress'), /worker-one/);
  assert.strictEqual(section(todo, 'Review'), '(Empty)');
  assert.strictEqual(section(todo, 'Completed'), '(Empty)');
});

test('refreshKeptTaskList with no tasks writes an empty snapshot and empty sections', { skip }, () => {
  const { root } = makeWorkspace();

  refreshKeptTaskList(root);

  const projection = readProjection(root);
  assert.deepStrictEqual(projection.tasks, []);
  assert.strictEqual(projection.surface.full_task_count, 0);
  assert.strictEqual(projection.surface.visible_task_count, 0);

  const todo = readTodo(root);
  for (const name of ['Backlog', 'In Progress', 'Review', 'Blocked', 'Completed']) {
    assert.strictEqual(section(todo, name), '(Empty)', `${name} should be empty`);
  }
});

test('refreshKeptTaskList leaves out tasks that belong to another workspace', { skip }, () => {
  const { root, db } = makeWorkspace();
  taskStore.addTask(db, { title: 'Mine to do', workspaceRoot: root });
  taskStore.addTask(db, { title: 'Somebody elses job', workspaceRoot: path.join(sandbox, 'elsewhere') });

  refreshKeptTaskList(root);

  assert.deepStrictEqual(readProjection(root).tasks.map(task => task.title), ['Mine to do']);
  const todo = readTodo(root);
  assert.match(todo, /Mine to do/);
  assert.doesNotMatch(todo, /Somebody elses job/);
});

test('refreshKeptTaskList moves a finished task to Completed and keeps the Endgame section', { skip }, () => {
  const { root, db } = makeWorkspace();
  taskStore.addTask(db, { title: 'Stays open', workspaceRoot: root });
  const doing = taskStore.addTask(db, {
    title: 'About to finish',
    workspaceRoot: root,
    status: 'claimed',
    claimedBy: 'worker-two',
  });

  refreshKeptTaskList(root);
  assert.match(section(readTodo(root), 'In Progress'), /About to finish/);

  fs.appendFileSync(path.join(root, 'atris', 'TODO.md'), '\n\n## Endgame\n\n- keep this line\n');
  taskStore.doneTask(db, { id: doing.id });
  refreshKeptTaskList(root);

  const byTitle = Object.fromEntries(readProjection(root).tasks.map(task => [task.title, task]));
  assert.strictEqual(byTitle['About to finish'].status, 'done');
  assert.strictEqual(byTitle['Stays open'].status, 'open');

  const todo = readTodo(root);
  assert.strictEqual(section(todo, 'In Progress'), '(Empty)');
  assert.match(section(todo, 'Completed'), /About to finish/);
  assert.match(section(todo, 'Backlog'), /Stays open/);
  assert.strictEqual(section(todo, 'Endgame'), '- keep this line');
});

test('refreshKeptTaskList does not create TODO.md when the folder has no atris directory', { skip }, () => {
  const { root, db } = makeWorkspace({ withAtrisDir: false });
  taskStore.addTask(db, { title: 'Lonely task', workspaceRoot: root });

  refreshKeptTaskList(root);

  assert.deepStrictEqual(readProjection(root).tasks.map(task => task.title), ['Lonely task']);
  assert.strictEqual(fs.existsSync(path.join(root, 'atris')), false);
});

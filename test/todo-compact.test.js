'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTodoMarkdown } = require('../lib/task-db');
const { parseSection, parseTodoFile } = require('../lib/todo-fallback');
const { getTaskGlance, loadContext } = require('../lib/state-detection');

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function rows() {
  return ['open', 'claimed', 'review', 'failed', ...Array(10).fill('done')].map((status, i) => ({
    id: `task-${i}`, title: `Task ${i} · exact title`, status,
    claimed_by: status === 'claimed' ? 'builder' : null,
    metadata: { todo_id: `T${i}`, assigned_to: 'architect', verify: 'node --test ' + 'test/long-name-'.repeat(6) + '.test.js',
      done_looks_like: 'Readers see the task and its proof', todo_tags: ['endgame'] },
  }));
}

test('compact TODO keeps lanes, owners, tags, approval detail and eight completed rows', t => {
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  const markdown = renderTodoMarkdown(rows());
  assert.match(markdown, /Details for any task: atris task show <ID>/);
  for (const [section, count] of [['Backlog', 1], ['In Progress', 1], ['Review', 1], ['Blocked', 1], ['Completed', 8]]) {
    const parsed = parseSection(markdown, section);
    assert.equal(parsed.length, count, section);
    assert.equal(parsed[0].tag, ['Backlog', 'Blocked'].includes(section) ? 'endgame' : null);
    assert.match(parsed[0].title, /^Task \d+ · exact title$/);
    assert.equal(parsed[0].verify, null, 'previews cannot be executed as commands');
    assert.equal(parsed[0].verify_preview || null, ['In Progress', 'Blocked'].includes(section)
      ? rows()[0].metadata.verify.slice(0, section === 'Blocked' ? 60 : 40) : null);
  }
  assert.equal(parseSection(markdown, 'In Progress')[0].claimed, 'builder');
  assert.equal(parseSection(markdown, 'Review')[0].claimed, 'architect');
  assert.equal((markdown.match(/Done looks like:/g) || []).length, 1);
  assert.doesNotMatch(markdown, /Why it matters:|Technical details:|Approve or change:|Claimed by:/);
  assert.match(markdown, /2 older completed tasks archived/);
});

test('missing owners and verification commands stay compact and full mode preserves old detail', t => {
  const row = { id: 'a', title: 'Read the guide', status: 'open', metadata: {} };
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  const compact = renderTodoMarkdown([row]);
  assert.match(compact, /Read the guide\n/);
  assert.doesNotMatch(compact, /verify:/);
  assert.equal(parseSection(compact, 'Backlog')[0].claimed, null);
  process.env.ATRIS_TODO_RENDER = 'full';
  const full = renderTodoMarkdown(rows());
  assert.match(full, /Why it matters:.*\n.*Done looks like:.*\n.*Approve or change:.*\n.*Technical details:/);
  assert.equal(parseSection(full, 'In Progress')[0].verify, rows()[0].metadata.verify);
  assert.equal(parseSection(full, 'In Progress')[0].claimed, 'builder');
});

test('real generated TODO feeds markdown task parsing, context and startup glance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-todo-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setEnv(t, 'ATRIS_TASKS_DB', path.join(root, 'missing.db'));
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  const atrisDir = path.join(root, 'atris');
  fs.mkdirSync(atrisDir);
  const todo = path.join(atrisDir, 'TODO.md');
  fs.writeFileSync(todo, renderTodoMarkdown(rows()));
  assert.equal(parseTodoFile(todo).review.length, 1);
  const glance = getTaskGlance(atrisDir);
  assert.equal(glance.backlog, 1);
  assert.equal(glance.active, 1);
  assert.equal(glance.review, 1);
  assert.equal(glance.reviewCertified, 0);
  assert.deepEqual(glance.activeTitles, ['Task 1 · exact title']);
  assert.deepEqual(loadContext(root).backlogTasks, ['Task 0 · exact title']);
  assert.equal(fs.existsSync(path.join(root, 'missing.db')), false);
});

test('compact boards resolve full commands from real task state without the database opt-in', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-todo-canonical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskDb = require('../lib/task-db');
  const dbPath = path.join(root, 'tasks.db');
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close(db));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris/atris.md'), '');
  const title = 'Check the [saved] command';
  const verify = 'node --test test/a-long-test-name-that-must-not-be-clipped-or-replaced.test.js';
  taskDb.addTask(db, { title, workspaceRoot: taskDb.workspaceRoot(root), tag: 'docs', metadata: { verify, todo_tags: ['endgame', 'execute'] } });
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  fs.writeFileSync(path.join(root, 'atris/TODO.md'), renderTodoMarkdown(taskDb.listTasks(db, { workspaceRoot: taskDb.workspaceRoot(root) })));
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const todo = require(${JSON.stringify(require.resolve('../lib/todo'))}).parseTodo(${JSON.stringify(path.join(root, 'atris/TODO.md'))});
    assert.equal(todo.backlog.length, 1);
    assert.equal(todo.backlog[0].title, ${JSON.stringify(title)});
    assert.equal(todo.backlog[0].verify, ${JSON.stringify(verify)});
    assert.equal(todo.backlog[0].tag, 'endgame');
    assert.ok(todo.backlog[0].tags.includes('execute'));
    const command = require(${JSON.stringify(require.resolve('../commands/autopilot'))}).getVerifyCommand(${JSON.stringify(root)}, ${JSON.stringify(title)});
    assert.deepEqual(command, { cmd: ${JSON.stringify(verify)}, explicit: true });
  `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, ATRIS_TASKS_DB: dbPath, ATRIS_TASK_DB: '0' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('compact lane limits shorten display text without changing task data', t => {
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  const tasks = rows().map(row => ({ ...row, title: 'x'.repeat(200),
    metadata: { ...row.metadata, done_looks_like: 'y'.repeat(240) } }));
  const before = JSON.stringify(tasks);
  const markdown = renderTodoMarkdown(tasks);
  for (const section of ['Backlog', 'In Progress', 'Review', 'Completed']) {
    const task = parseSection(markdown, section)[0];
    const limit = section === 'Completed' ? 100 : 140;
    assert.equal(task.title, 'x'.repeat(limit - 1) + '…');
  }
  assert.match(markdown, new RegExp('  \\*\\*Done looks like:\\*\\* ' + 'y'.repeat(159) + '…\\n'));
  assert.doesNotMatch(markdown.split('## In Progress')[0], /architect|verify:/);
  assert.equal(JSON.stringify(tasks), before);
  process.env.ATRIS_TODO_RENDER = 'full';
  assert.ok(renderTodoMarkdown(tasks).includes('x'.repeat(200)));
  assert.ok(renderTodoMarkdown(tasks).includes('y'.repeat(240)));
});

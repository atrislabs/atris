'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Set the home before loading task.js or its dependencies, and fence every
// inherited Atris option so the test cannot select a user's database or mode.
function withSandbox(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-render-'));
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  let store;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    const { autoRenderTodoFromDb } = require('../commands/task');
    store = require('../lib/task-db');
    const db = store.open();
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
    // Insert fixed fixture rows directly to avoid creation APIs that use Date.now().
    function insert(id, title, status = 'open', ws = workspace) {
      db.prepare(`INSERT INTO tasks
        (id, title, status, workspace_root, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, status, ws, 1704067200000, 1704067200000, '{}');
    }
    run({ root, workspace, insert, autoRenderTodoFromDb });
  } finally {
    if (store) store.close();
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('autoRenderTodoFromDb creates a TODO from only the requested workspace', () => {
  withSandbox(({ root, workspace, insert, autoRenderTodoFromDb }) => {
    insert('task-alpha', 'Prepare the release notes');
    insert('task-beta', 'Check the finished export', 'review');
    insert('task-other', 'Keep this other workspace private', 'open', path.join(root, 'other'));
    const output = path.join(workspace, 'atris', 'TODO.md');
    assert.strictEqual(autoRenderTodoFromDb(workspace), output);
    const markdown = fs.readFileSync(output, 'utf8');
    assert.match(markdown, /^# TODO\.md\n/);
    assert.match(markdown, /## Backlog\n[\s\S]*Prepare the release notes/);
    assert.match(markdown, /## Review\n[\s\S]*Check the finished export/);
    assert.doesNotMatch(markdown, /Keep this other workspace private/);
  });
});

test('autoRenderTodoFromDb refreshes an existing TODO and preserves Endgame', () => {
  withSandbox(({ workspace, insert, autoRenderTodoFromDb }) => {
    insert('task-alpha', 'Read the latest database task');
    const output = path.join(workspace, 'atris', 'TODO.md');
    fs.writeFileSync(output, '# Old heading\n\n## Endgame\n\nMake exports easy to share.\n\n## Backlog\n\n(Empty)\n');
    assert.strictEqual(autoRenderTodoFromDb(workspace), output);
    const markdown = fs.readFileSync(output, 'utf8');
    assert.match(markdown, /^# TODO\.md\n/);
    assert.match(markdown, /## Endgame\n\nMake exports easy to share\./);
    assert.match(markdown, /Read the latest database task/);
    assert.doesNotMatch(markdown, /Old heading/);
    assert.strictEqual(autoRenderTodoFromDb(workspace), output);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), markdown);
  });
});

test('autoRenderTodoFromDb renders an empty database and skips missing atris folders', () => {
  withSandbox(({ root, workspace, autoRenderTodoFromDb }) => {
    const output = path.join(workspace, 'atris', 'TODO.md');
    assert.strictEqual(autoRenderTodoFromDb(workspace), output);
    const markdown = fs.readFileSync(output, 'utf8');
    for (const heading of ['Backlog', 'In Progress', 'Review', 'Blocked', 'Completed']) {
      assert.ok(markdown.includes(`## ${heading}\n\n(Empty)`), heading);
    }
    const missing = path.join(root, 'no-workspace');
    assert.strictEqual(autoRenderTodoFromDb(missing), null);
    assert.strictEqual(fs.existsSync(missing), false);
  });
});

test('autoRenderTodoFromDb returns null when TODO is a directory', () => {
  withSandbox(({ workspace, autoRenderTodoFromDb }) => {
    const output = path.join(workspace, 'atris', 'TODO.md');
    fs.mkdirSync(output);
    const marker = path.join(output, 'keep.txt');
    fs.writeFileSync(marker, 'untouched');
    assert.strictEqual(autoRenderTodoFromDb(workspace), null);
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'untouched');
    assert.strictEqual(fs.statSync(output).isDirectory(), true);
  });
});

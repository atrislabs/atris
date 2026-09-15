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
    assert.equal(parsed[0].tag, 'endgame');
    assert.match(parsed[0].title, /^Task \d+ · exact title$/);
    assert.equal(parsed[0].verify, null, 'previews cannot be executed as commands');
    assert.equal(parsed[0].verify_preview, rows()[0].metadata.verify.slice(0, 60));
  }
  assert.equal(parseSection(markdown, 'In Progress')[0].claimed, 'builder');
  assert.equal(parseSection(markdown, 'Review')[0].claimed, 'architect');
  assert.equal((markdown.match(/Done looks like:/g) || []).length, 2);
  assert.doesNotMatch(markdown, /Why it matters:|Technical details:|Approve or change:|Claimed by:/);
  assert.match(markdown, /2 older completed tasks archived/);
});

test('missing owners and verification commands stay compact and full mode preserves old detail', t => {
  const row = { id: 'a', title: 'Read the guide', status: 'open', metadata: {} };
  setEnv(t, 'ATRIS_TODO_RENDER', 'compact');
  const compact = renderTodoMarkdown([row]);
  assert.match(compact, /Read the guide · unassigned\n/);
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

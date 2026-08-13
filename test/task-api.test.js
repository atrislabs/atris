'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskStore = require('../lib/task-db');
const { createTaskApiServer } = require('../commands/task');

let workspace;
let previousCwd;
let previousTasksDb;
let db;
let server;
let baseUrl;
let seededTaskId;

test.before(async () => {
  previousCwd = process.cwd();
  previousTasksDb = process.env.ATRIS_TASKS_DB;
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-api-test-')));
  fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.atris', 'state'), { recursive: true });
  process.chdir(workspace);
  process.env.ATRIS_TASKS_DB = path.join(workspace, '.atris', 'state', 'tasks.db');

  db = taskStore.open();
  seededTaskId = taskStore.addTask(db, {
    title: 'Operators can read the seeded task from the board API',
    tag: 'task-api-test',
    workspaceRoot: workspace,
  }).id;

  server = createTaskApiServer({ taskDb: taskStore, db });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
  taskStore.close();
  if (previousCwd) process.chdir(previousCwd);
  if (previousTasksDb === undefined) delete process.env.ATRIS_TASKS_DB;
  else process.env.ATRIS_TASKS_DB = previousTasksDb;
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

test('task board page responds with HTML', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html;/);
  assert.match(await response.text(), /<html lang="en">/);
});

test('task board page leads with the plain explanation and keeps approval gated', async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /What changes/);
  assert.match(html, /Why it matters/);
  assert.match(html, /Done looks like/);
  assert.match(html, /Technical details/);
  assert.match(html, /approval\.approve\.enabled/);
  assert.match(html, /Approval not ready/);
});

test('task list API returns projection tasks', async () => {
  const response = await fetch(`${baseUrl}/api/tasks`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.projection.tasks.some(task => task.id === seededTaskId));
});

test('activity stream uses event-stream headers and keeps its JSON payload', async () => {
  const response = await fetch(`${baseUrl}/api/stream`);
  const payload = JSON.parse(await response.text());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream;/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.events));
});

test('capabilities route is read-only and cannot accept human proof', async () => {
  const response = await fetch(`${baseUrl}/api/tasks/capabilities`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.action, 'capabilities');
  assert.equal(payload.safety.read_only, true);
  assert.equal(payload.safety.human_accept, false);
});

test('capability check passes and keeps the human-accept lane denied', async () => {
  const response = await fetch(`${baseUrl}/api/tasks/capabilities/check?owner=api-test`);
  const payload = await response.json();
  const humanAcceptCheck = payload.checks.find(check => check.name === 'current_step_never_human_accepts');

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.failed, 0);
  assert.equal(humanAcceptCheck.ok, true);
  assert.equal(payload.capabilities.current_step.lanes['human-accept-waiting'].safe_for_agent, false);
});

test('POST task mutation persists and appears in the next projection', async () => {
  const title = 'Operators can save a task through the API and read it after refresh';
  const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, tag: 'task-api-test' }),
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 200);
  assert.equal(created.action, 'created');
  assert.equal(taskStore.getTask(db, created.task_id).title, title);

  const listResponse = await fetch(`${baseUrl}/api/tasks`);
  const listed = await listResponse.json();
  assert.ok(listed.projection.tasks.some(task => task.id === created.task_id && task.title === title));
});

test('POST task creation accepts explicit plain fields and preserves technical metadata', async () => {
  const title = 'canonical_schema keeps --raw-mode available in src/task-api.js';
  const verify = 'node --test test/task-api.test.js';
  const explanation = {
    what_changes: 'People see the task in plain words before the technical details',
    why_it_matters: 'This makes review faster because the decision is clear',
    done_looks_like: 'The plain summary leads and the exact task record remains available',
  };
  const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, verify, explanation, tag: 'task-api-test' }),
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 200);
  assert.equal(created.task.title, title);
  assert.equal(created.task.metadata.verify, verify);
  assert.equal(created.task.metadata.what_changes, explanation.what_changes);
  assert.equal(created.task.metadata.why_it_matters, explanation.why_it_matters);
  assert.equal(created.task.metadata.done_looks_like, explanation.done_looks_like);
  assert.equal(created.task.explanation.what_changes, `${explanation.what_changes}.`);
  assert.equal(created.task.explanation.why_it_matters, `${explanation.why_it_matters}.`);
  assert.equal(created.task.explanation.done_looks_like, `${explanation.done_looks_like}.`);
  assert.equal(created.task.approval.approve.enabled, false);
  assert.equal(created.task.approval.request_change.enabled, true);

  const detailResponse = await fetch(`${baseUrl}/api/tasks/${created.task_id}`);
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.task.title, title);
  assert.equal(detail.task.metadata.verify, verify);
  assert.equal(detail.page.explanation.what_changes, `${explanation.what_changes}.`);
  assert.equal(detail.page.review.human_accept.enabled, false);
  assert.equal(detail.page.approval.approve.command, null);
  assert.match(detail.page.approval.request_change.command, /^atris task backlog /);
});

test('unknown task API route responds with JSON 404', async () => {
  const response = await fetch(`${baseUrl}/api/tasks/not-a-route/extra`);
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(payload, { ok: false, reason: 'not_found' });
});

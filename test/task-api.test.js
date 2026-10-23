'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const taskStore = require('../lib/task-db');
const { createTaskApiServer } = require('../commands/task');

let workspace;
let previousCwd;
let previousTasksDb;
let db;
let server;
let baseUrl;
let seededTaskId;

function boardFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { 'x-atris-token': server.taskToken || 'before-fix', ...options.headers } });
}

function rawRequest(target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl, { path: target, method, headers, setHost: headers.host !== '' }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.end(body);
  });
}

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
  const response = await boardFetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html;/);
  assert.match(await response.text(), /<html lang="en">/);
});

test('task board page leads with the plain explanation and keeps approval gated', async () => {
  const response = await boardFetch(`${baseUrl}/`);
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
  const response = await boardFetch(`${baseUrl}/api/tasks`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.projection.tasks.some(task => task.id === seededTaskId));
});

test('activity stream uses event-stream headers and keeps its JSON payload', async () => {
  const response = await boardFetch(`${baseUrl}/api/stream`);
  const payload = JSON.parse(await response.text());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream;/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.events));
});

test('capabilities route is read-only and cannot accept human proof', async () => {
  const response = await boardFetch(`${baseUrl}/api/tasks/capabilities`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.action, 'capabilities');
  assert.equal(payload.safety.read_only, true);
  assert.equal(payload.safety.human_accept, false);
});

test('capability check passes and keeps the human-accept lane denied', async () => {
  const response = await boardFetch(`${baseUrl}/api/tasks/capabilities/check?owner=api-test`);
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
  const createdResponse = await boardFetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, tag: 'task-api-test' }),
  });
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 200);
  assert.equal(created.action, 'created');
  assert.equal(taskStore.getTask(db, created.task_id).title, title);

  const listResponse = await boardFetch(`${baseUrl}/api/tasks`);
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
  const createdResponse = await boardFetch(`${baseUrl}/api/tasks`, {
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

  const detailResponse = await boardFetch(`${baseUrl}/api/tasks/${created.task_id}`);
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
  const response = await boardFetch(`${baseUrl}/api/tasks/not-a-route/extra`);
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(payload, { ok: false, reason: 'not_found' });
});


test('task board refuses a cross-site task creation without changing the database', async () => {
  const before = taskStore.listTasks(db, { workspaceRoot: workspace });
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
    body: JSON.stringify({ title: 'A stranger must never create this task' }),
  });
  await response.text();
  assert.equal(response.status, 403);
  assert.deepEqual(taskStore.listTasks(db, { workspaceRoot: workspace }), before);
});

test('task board uses one per-run token for reads and every mutation route', async () => {
  assert.equal((await fetch(`${baseUrl}/`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/tasks`)).status, 403);
  const page = await fetch(`${baseUrl}/?t=${server.taskToken}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /x-atris-token/);
  const before = taskStore.getTask(db, seededTaskId);
  const events = taskStore.listTaskEvents(db, { taskId: seededTaskId });
  const routes = [
    '/api/tasks', '/api/tasks/clear-plan', '/api/tasks/current/step',
    '/api/tasks/review-lane-act', '/api/tasks/review-lane-loop', '/api/tasks/review-lane-run',
    ...['claim', 'accept', 'revise', 'ready', 'plan', 'do', 'backlog', 'message', 'chat',
      'step', 'finish', 'review', 'review-chat', 'continue-work'].map(op => `/api/tasks/${seededTaskId}/${op}`),
  ];
  for (const route of routes) {
    for (const tokenQuery of ['', `?t=${server.taskToken}`]) {
      const response = await fetch(`${baseUrl}${route}${tokenQuery}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      await response.text();
      assert.equal(response.status, 403, 'mutation must require the token header');
    }
  }
  assert.deepEqual(taskStore.getTask(db, seededTaskId), before);
  assert.deepEqual(taskStore.listTaskEvents(db, { taskId: seededTaskId }), events);
  const other = createTaskApiServer({ taskDb: taskStore, db });
  assert.ok(other.taskToken && other.taskToken !== server.taskToken, 'tokens are unique per server run');
});

test('task board rejects foreign hosts and origins even with a valid token', async () => {
  for (const host of ['evil.example', `evil.example:${server.address().port}`, '']) {
    assert.equal(await rawRequest('/api/tasks', { headers: { host, 'x-atris-token': server.taskToken } }), 403);
    assert.equal(await rawRequest('/api/tasks', {
      method: 'POST', headers: { host, 'x-atris-token': server.taskToken, 'content-type': 'application/json' }, body: '{}',
    }), 403);
  }
  const response = await boardFetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 403);
  assert.equal((await boardFetch(`${baseUrl}/api/tasks`, { headers: { 'x-atris-token': 'wrong' } })).status, 403);
  assert.equal(await rawRequest('/api/tasks', {
    headers: { host: `localhost:${server.address().port}`, 'x-atris-token': server.taskToken },
  }), 200);
});

test('task board returns 4xx for malformed URLs and bodies and keeps serving', async () => {
  for (const target of ['//x:99999', 'http://x:99999/', '/%ZZ', '/%00']) {
    assert.equal(await rawRequest(target), 400);
  }
  const headers = { 'x-atris-token': server.taskToken, 'content-type': 'application/json' };
  assert.equal(await rawRequest('/api/tasks', { headers: { ...headers, 'content-length': 2 }, body: '{}' }), 400);
  for (const body of ['{', 'null', '[]', '"x"']) {
    assert.equal(await rawRequest('/api/tasks', { method: 'POST', headers, body }), 400);
  }
  for (const padding of ['x'.repeat(1_000_001), 'é'.repeat(500_001)]) {
    assert.equal(await rawRequest('/api/tasks', {
      method: 'POST', headers, body: JSON.stringify({ padding }),
    }), 413);
  }
  assert.equal(await rawRequest('/api/tasks', {
    method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}',
  }), 415);
  const response = await boardFetch(`${baseUrl}/api/tasks`, {
    method: 'POST', headers: { ...headers, origin: baseUrl }, body: JSON.stringify({ title: 'The board still works after bad requests' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await boardFetch(`${baseUrl}/api/tasks`)).status, 200);
  assert.equal((await boardFetch(`${baseUrl}/api/tasks?label=%23%5C`)).status, 200);
  assert.equal(server.address().address, '127.0.0.1');
});

test('the board page carries its pairing token through real read and write requests', async () => {
  const vm = require('node:vm');
  const response = await fetch(`${baseUrl}/?t=${server.taskToken}`);
  const html = await response.text();
  const script = html.match(/    async function api\(path, options = \{\}\) \{[\s\S]*?\n    \}/)[0];
  const context = vm.createContext({
    URLSearchParams,
    location: { search: `?t=${server.taskToken}` },
    fetch: (route, options) => fetch(`${baseUrl}${route}`, {
      ...options, headers: { ...options.headers, origin: baseUrl },
    }),
  });
  vm.runInContext(script, context);
  const listed = await context.api('/api/tasks');
  assert.equal(listed.ok, true);
  const created = await context.api('/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: 'People can keep using the paired board page' }),
  });
  assert.equal(taskStore.getTask(db, created.task_id).title, 'People can keep using the paired board page');
});

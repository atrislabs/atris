'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function taskRef(payload) {
  return payload.task.display_id || payload.task.ref || payload.task_id;
}

function projectionTask(workspace, id) {
  const projectionPath = path.join(workspace, '.atris', 'state', 'tasks.projection.json');
  assert.ok(fs.existsSync(projectionPath), 'task projection should exist');
  const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
  const task = projection.tasks.find(row => (
    row.id === id
    || row.display_id === id
    || row.legacy_ref === id
  ));
  assert.ok(task, `task ${id} should exist in projection`);
  return task;
}

function assertProjectionStatus(ctx, id, status) {
  assert.equal(projectionTask(ctx.workspace, id).status, status);
}

module.exports = {
  id: 'task-lifecycle-roundtrip',
  title: 'Task state round-trips through create, claim, review, accept, and show',
  timeoutMs: 30000,
  async run(ctx) {
    fs.mkdirSync(path.join(ctx.workspace, 'atris'), { recursive: true });
    const created = parseJson(ctx.runCli(['task', 'new', 'Losing task state costs follow-through: roundtrip one task', '--tag', 'bench', '--json']));
    assert.equal(created.task.status, 'open');
    const ref = taskRef(created);
    assertProjectionStatus(ctx, created.task_id, 'open');

    const claimed = parseJson(ctx.runCli(['task', 'claim', ref, '--as', 'bench', '--json']));
    assert.equal(claimed.task.status, 'claimed');
    assert.equal(claimed.task.claimed_by, 'bench');
    assertProjectionStatus(ctx, created.task_id, 'claimed');

    const ready = parseJson(ctx.runCli(['task', 'ready', ref, '--verify', 'node -e "process.exit(0)"', '--result', 'Operators can now follow one task from claim to done without losing state.', '--as', 'bench', '--json']));
    assert.equal(ready.task.status, 'review');
    assert.equal(ready.approval_status, 'pending');
    assertProjectionStatus(ctx, created.task_id, 'review');

    const accepted = parseJson(ctx.runCli(['task', 'accept', ref, '--as', 'bench-human', '--json']));
    assert.equal(accepted.task.status, 'done');
    assertProjectionStatus(ctx, created.task_id, 'done');

    const shown = parseJson(ctx.runCli(['task', 'show', ref, '--json']));
    assert.equal(shown.status, 'done');
    assert.equal(shown.id, created.task_id);
  },
};

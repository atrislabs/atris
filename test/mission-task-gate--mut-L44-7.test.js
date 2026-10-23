'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missionLinkedTaskGate } = require('../lib/mission-task-gate');

test('an unaccepted task linked by legacy reference blocks completion', () => {
  const row = {
    id: 'AAAAAAAAAAAA',
    legacy_ref: 'T42',
    workspace_root: '/workspace',
    status: 'open',
    metadata: {},
  };
  const taskDb = {
    open: () => ({}),
    getTask: (_db, ref) => ref === row.id ? row : null,
    listTasks: () => [row],
    withTaskDisplayRefs: (rows) => rows.map((task) => ({ ...task, display_id: 'WRK-1' })),
    workspaceRoot: () => '/workspace',
    listTaskEvents: () => [],
  };
  const result = missionLinkedTaskGate({ task_ids: ['T42'] }, '/workspace', { taskDb });
  assert.equal(result.ok, false);
});

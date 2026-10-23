'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missionLinkedTaskGate } = require('../lib/mission-task-gate');

test('a short task reference selects its accepted task instead of another pending task', () => {
  const rows = [
    { id: 'AAAAAAAAAAAA', workspace_root: '/w', status: 'open', metadata: {} },
    { id: 'BBBBBBBBBBBB', workspace_root: '/w', status: 'done', metadata: { approval_status: 'accepted', latest_agent_proof: 'receipt' } },
  ];
  const taskDb = {
    open: () => ({}),
    getTask: (_db, ref) => rows.find((row) => row.id === ref) || null,
    listTasks: () => rows,
    withTaskDisplayRefs: (list) => list.map((row, index) => ({ ...row, display_id: `WRK-${index + 1}` })),
    workspaceRoot: () => '/w',
    listTaskEvents: () => [],
  };
  const result = missionLinkedTaskGate({ task_ids: ['WRK-2'] }, '/w', { taskDb });
  assert.strictEqual(result.ok, true);
});

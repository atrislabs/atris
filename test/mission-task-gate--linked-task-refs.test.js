'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { linkedTaskRefs } = require('../lib/mission-task-gate');

test('collects linked tasks from every supported field in priority order', () => {
  assert.deepStrictEqual(linkedTaskRefs({
    task_ids: ['task-a', 'task-b'],
    xp_task: { task_id: 'task-c' },
    current_task_id: 'task-d',
    task_id: 'task-e',
  }), ['task-a', 'task-b', 'task-c', 'task-d', 'task-e']);
});

test('trims refs and removes duplicates while preserving first occurrence and case', () => {
  const mission = {
    task_ids: [' task-b ', 'task-a', 'task-b', 'TASK-A', '   '],
    xp_task: { task_id: ' task-a ' },
    current_task_id: ' task-c ',
    task_id: 'task-b',
  };
  const original = JSON.stringify(mission);

  assert.deepStrictEqual(linkedTaskRefs(mission), ['task-b', 'task-a', 'TASK-A', 'task-c']);
  assert.strictEqual(JSON.stringify(mission), original);
});

test('converts truthy values to strings and discards falsy refs', () => {
  assert.deepStrictEqual(linkedTaskRefs({
    task_ids: [null, undefined, false, 0, '', 42, true, '42'],
    xp_task: { task_id: 7 },
  }), ['42', 'true', '7']);
});

test('handles absent missions, empty refs, and non-array task lists', () => {
  assert.deepStrictEqual(linkedTaskRefs(), []);
  assert.deepStrictEqual(linkedTaskRefs(null), []);
  assert.deepStrictEqual(linkedTaskRefs({}), []);
  assert.deepStrictEqual(linkedTaskRefs({
    task_ids: [],
    xp_task: null,
    current_task_id: ' ',
    task_id: '',
  }), []);
  assert.deepStrictEqual(linkedTaskRefs({
    task_ids: 'ignored-task',
    task_id: 'single-task',
  }), ['single-task']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const taskCore = require('../lib/task-core');
const taskCmd = require('../commands/task');

test('lib/task-core exports shared constants and helpers used by commands/task.js', () => {
  assert.equal(typeof taskCore.DEFAULT_OWNER, 'string');
  assert.ok(taskCore.DEFAULT_OWNER.length > 0);
  assert.ok(Array.isArray(taskCore.TASK_QUEUE_COLUMN_ORDER));
  assert.ok(taskCore.TASK_QUEUE_COLUMN_ORDER.length >= 3);
  assert.equal(typeof taskCore.taskUsageText, 'function');
  assert.match(taskCore.taskUsageText(), /atris task - durable local task state/);
});

test('lib/task-core flag, positional, and lookup helpers behave deterministically', () => {
  const args = ['claim', 'CLI-123', '--as', 'builder', '--json'];
  assert.equal(taskCore.flag(args, '--as'), 'builder');
  assert.equal(taskCore.wantsJson(args), true);
  assert.deepEqual(taskCore.positional(args), ['claim', 'CLI-123']);
  assert.equal(taskCore.normalizeTaskLookupRef('#CLI-123'), 'CLI123');
});

test('lib/task-core proof and landing validation helpers catch weak proof and render board HTML', () => {
  assert.equal(
    taskCore.meaningfulTaskProofIssue('done'),
    'proof must name what was verified, changed, approved, or produced',
  );
  assert.equal(taskCore.meaningfulTaskProofIssue('node --test test/task-core.test.js passed 3/3'), null);
  assert.equal(
    taskCore.resultSentenceIssue('Updated task.js'),
    'result is too short to explain what changed for a human.',
  );
  assert.equal(
    taskCore.resultSentenceIssue('Shared task and mission helpers now live in small core modules so parallel builders stop clashing on the main command files.'),
    null,
  );

  const viewModel = taskCore.taskBoardViewModel({
    workspace_root: '/tmp/demo',
    counts: { open: 1, claimed: 0, review: 0, done: 0 },
    tasks: [{ id: '01TEST', display_id: 'CLI-1', title: 'Keep board rendering fast', status: 'open' }],
  });
  assert.equal(viewModel.total, 1);
  const html = taskCore.taskBoardHtml(viewModel);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Atris Task Factory/);
});

test('commands/task.js re-exports compatible public surface alongside lib/task-core.js', () => {
  assert.equal(taskCmd.taskBoardViewModel, taskCore.taskBoardViewModel);
  assert.equal(taskCmd.taskBoardTemplate, taskCore.taskBoardTemplate);
  assert.equal(taskCmd.AGENT_ENV_MARKERS, taskCore.AGENT_ENV_MARKERS);
  assert.equal(typeof taskCmd.run, 'function');
});

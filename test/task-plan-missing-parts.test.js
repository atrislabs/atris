'use strict';

// A planned job's "cannot approve yet" line names only the plan parts that
// are really missing. Before, it always listed goal, finish line, check, and
// first move, so a job given a check was still told it needed one.

const test = require('node:test');
const assert = require('node:assert/strict');

const { taskApprovalFor } = require('../commands/task');

function plannedTask(metadata, extra = {}) {
  return { id: 'T-1', title: 'Make the button blue', status: 'open', metadata: { stage: 'plan', ...metadata }, ...extra };
}

test('a job given a check and a finish line is only asked for what is missing', () => {
  const approval = taskApprovalFor(plannedTask({ verify: 'npm test', exit_condition: 'button is blue' }));
  const reason = approval.approve.blocked_reason;
  assert.equal(reason, 'The plan still needs a goal and a first move before approval.');
  assert.doesNotMatch(reason, /check|finish line/);
});

test('an empty plan still names all four parts', () => {
  const approval = taskApprovalFor(plannedTask({}));
  assert.equal(
    approval.approve.blocked_reason,
    'The plan still needs a goal, a finish line, a check, and a first move before approval.',
  );
});

test('a complete plan can be approved with no blocked reason', () => {
  const approval = taskApprovalFor(plannedTask({
    task_goal: 'blue button',
    exit_condition: 'button is blue',
    verify: 'npm test',
    first_move: 'edit the css',
  }));
  assert.equal(approval.approve.enabled, true);
  assert.equal(approval.approve.blocked_reason, null);
});

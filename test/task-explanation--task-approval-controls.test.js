'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { taskApprovalControls } = require('../lib/task-explanation');

test('labels enabled approval and change commands without blocking approval', () => {
  assert.deepStrictEqual(taskApprovalControls({
    acceptEnabled: true,
    acceptCommand: 'atris task accept example',
    requestChangeEnabled: true,
    requestChangeCommand: 'atris task revise example',
    blockedReason: 'An old block',
    waitingOn: 'The owner',
  }), {
    question: 'Approve this work, or ask for a change?',
    approve: {
      label: 'Approve this work',
      enabled: true,
      command: 'atris task accept example',
      human_only: true,
      blocked_reason: null,
    },
    request_change: {
      label: 'Ask for a change',
      enabled: true,
      command: 'atris task revise example',
    },
    waiting_on: 'The owner',
  });
});

test('empty input disables both controls and supplies default text', () => {
  const expected = {
    question: 'Nothing to approve yet.',
    approve: {
      label: 'Approve this work',
      enabled: false,
      command: null,
      human_only: true,
      blocked_reason: null,
    },
    request_change: {
      label: 'Ask for a change',
      enabled: false,
      command: null,
    },
    waiting_on: null,
  };
  assert.deepStrictEqual(taskApprovalControls(), expected);
  assert.deepStrictEqual(taskApprovalControls({}), expected);
});

test('approval requires both permission and a nonempty command', () => {
  for (const input of [
    { acceptEnabled: false, acceptCommand: 'atris task accept example' },
    { acceptEnabled: true, acceptCommand: null },
    { acceptEnabled: true, acceptCommand: '' },
  ]) {
    const result = taskApprovalControls({ ...input, blockedReason: 'Proof is missing' });
    assert.strictEqual(result.question, 'Nothing to approve yet.');
    assert.strictEqual(result.approve.enabled, false);
    assert.strictEqual(result.approve.command, null);
    assert.strictEqual(result.approve.blocked_reason, 'Proof is missing');
    assert.strictEqual(result.approve.human_only, true);
  }
});

test('custom text survives and change controls respect permission and missing commands', () => {
  const result = taskApprovalControls({
    question: 'Ready to publish?',
    approveLabel: 'Publish this work',
    requestChangeEnabled: false,
    requestChangeCommand: 'atris task revise example',
    waitingOn: '',
    blockedReason: '',
  });
  assert.strictEqual(result.question, 'Ready to publish?');
  assert.strictEqual(result.approve.label, 'Publish this work');
  assert.strictEqual(result.approve.blocked_reason, null);
  assert.strictEqual(result.waiting_on, null);
  assert.deepStrictEqual(result.request_change, {
    label: 'Ask for a change', enabled: false, command: null,
  });

  const missingCommand = taskApprovalControls({ requestChangeEnabled: true });
  assert.strictEqual(missingCommand.question, 'Approve this work, or ask for a change?');
  assert.deepStrictEqual(missingCommand.request_change, {
    label: 'Ask for a change', enabled: false, command: null,
  });
});

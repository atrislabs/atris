'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idleDecision } = require('../lib/idle-review-sweep');

test('a review with missing activity dates keeps its grace period', () => {
  const task = {
    id: 'undated-review',
    title: 'Polish list spacing',
    status: 'review',
    tag: 'ui',
    review: { approval_status: 'pending' },
  };

  const decision = idleDecision(task, {
    now: Date.UTC(2026, 0, 15, 12),
    liveReasons: new Map([[task.id, 'no_verify_command']]),
  });

  assert.equal(decision.action, 'wait');
});

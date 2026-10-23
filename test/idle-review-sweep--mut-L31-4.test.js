'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idleDecision } = require('../lib/idle-review-sweep');

test('zero idle close days uses the default grace period', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const task = {
    id: 'zero-grace-review',
    title: 'Polish the list spacing',
    status: 'review',
    tag: 'ui',
    created_at: now - 24 * 60 * 60 * 1000,
    review: { approval_status: 'pending' },
  };

  assert.deepEqual(idleDecision(task, {
    policy: { idle_close_days: 0 },
    now,
    liveReasons: new Map([[task.id, 'no_verify_command']]),
  }), { action: 'wait', why: 'still_in_grace' });
});

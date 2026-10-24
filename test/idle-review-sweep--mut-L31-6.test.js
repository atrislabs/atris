'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idleDecision } = require('../lib/idle-review-sweep');

test('negative idle days preserve the default grace period', () => {
  const decision = idleDecision({
    id: 'recent-review',
    title: 'Polish the inbox list',
    status: 'review',
    tag: 'ui',
    created_at: Date.UTC(2026, 9, 5, 12),
    review: { approval_status: 'pending' },
  }, {
    now: Date.UTC(2026, 9, 6, 12),
    policy: { idle_close_days: -1 },
    liveReasons: new Map([['recent-review', 'verify_failed_on_main']]),
  });

  assert.equal(decision.action, 'wait');
});

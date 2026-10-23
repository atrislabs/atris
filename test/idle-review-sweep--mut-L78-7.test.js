'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idleDecision } = require('../lib/idle-review-sweep');

test('open work is skipped even when it belongs to a protected lane', () => {
  const decision = idleDecision({
    id: 'open-billing',
    title: 'Update billing settings',
    status: 'open',
    tag: 'billing',
    created_at: Date.UTC(2026, 0, 1),
    updated_at: Date.UTC(2026, 0, 1),
    metadata: {},
  }, {
    now: Date.UTC(2026, 0, 20),
    policy: { accept_all: true, strict_verify: true },
  });

  assert.strictEqual(decision.action, 'skip');
});

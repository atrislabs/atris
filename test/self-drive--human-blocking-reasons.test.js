'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HUMAN_BLOCKING_REASONS, reasonClass } = require('../lib/self-drive');

test('HUMAN_BLOCKING_REASONS holds exactly the three human-blocking classes', () => {
  assert.ok(HUMAN_BLOCKING_REASONS instanceof Set);
  assert.equal(HUMAN_BLOCKING_REASONS.size, 3);
  assert.ok(HUMAN_BLOCKING_REASONS.has('auth-required'));
  assert.ok(HUMAN_BLOCKING_REASONS.has('model-unavailable'));
  assert.ok(HUMAN_BLOCKING_REASONS.has('rate-limit-exceeded-wall'));
});

test('membership matches after reasonClass normalizes messy input', () => {
  assert.ok(HUMAN_BLOCKING_REASONS.has(reasonClass('Auth Required')));
  assert.ok(HUMAN_BLOCKING_REASONS.has(reasonClass('  Model   Unavailable  ')));
  assert.ok(HUMAN_BLOCKING_REASONS.has(reasonClass('RATE-LIMIT-EXCEEDED-WALL')));
});

test('machine-blocking, misspelled, and empty reasons are not human-blocking', () => {
  for (const reason of ['repeated-error-runner-failed', 'verifier-failed', 'blocked', 'auth_required', 'auth', '']) {
    assert.equal(HUMAN_BLOCKING_REASONS.has(reason), false, `expected "${reason}" to miss`);
  }
  assert.equal(HUMAN_BLOCKING_REASONS.has(undefined), false);
  assert.equal(HUMAN_BLOCKING_REASONS.has(null), false);
  assert.equal(HUMAN_BLOCKING_REASONS.has(reasonClass('auth_required')), false);
});

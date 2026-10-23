'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { taskStartedAt } = require('../lib/first-minute');

// Fixed instants, built with Date.UTC so no clock or local time zone is read.
const CREATED = Date.UTC(2026, 9, 1, 9, 0, 0);
const CLAIMED = Date.UTC(2026, 9, 2, 15, 30, 0);

test('taskStartedAt prefers claimed_at over created_at when both are numbers', () => {
  const task = { created_at: CREATED, claimed_at: CLAIMED };
  assert.strictEqual(taskStartedAt(task), CLAIMED);
});

test('taskStartedAt falls back to created_at when claimed_at is missing, null, or empty', () => {
  assert.strictEqual(taskStartedAt({ created_at: CREATED }), CREATED);
  assert.strictEqual(taskStartedAt({ created_at: CREATED, claimed_at: null }), CREATED);
  assert.strictEqual(taskStartedAt({ created_at: CREATED, claimed_at: '' }), CREATED);
});

test('taskStartedAt reads ISO strings with a Z suffix as UTC milliseconds', () => {
  const task = {
    created_at: '2026-10-01T09:00:00Z',
    claimed_at: '2026-10-02T15:30:00.000Z',
  };
  assert.strictEqual(taskStartedAt(task), CLAIMED);
  assert.strictEqual(taskStartedAt({ created_at: '2026-10-01T09:00:00Z' }), CREATED);
});

test('taskStartedAt treats a numeric string as milliseconds', () => {
  assert.strictEqual(taskStartedAt({ claimed_at: String(CLAIMED) }), CLAIMED);
});

test('taskStartedAt treats a zero claimed_at as unset and uses created_at', () => {
  assert.strictEqual(taskStartedAt({ claimed_at: 0, created_at: CREATED }), CREATED);
});

test('taskStartedAt falls back to created_at when claimed_at cannot be parsed', () => {
  const task = { claimed_at: 'not a date', created_at: CREATED };
  assert.strictEqual(taskStartedAt(task), CREATED);
});

test('taskStartedAt returns 0 for a missing task or a task with no usable timestamps', () => {
  assert.strictEqual(taskStartedAt(null), 0);
  assert.strictEqual(taskStartedAt(undefined), 0);
  assert.strictEqual(taskStartedAt({}), 0);
  assert.strictEqual(taskStartedAt({ claimed_at: 'not a date', created_at: 'also not' }), 0);
});

'use strict';

// coolingView turns a benched engine into the one line the roster and engine
// views print. It reads the clock in local time, so each test builds its
// cooling_until from local-time parts. The printed hh:mm then matches in any
// time zone, and no test reads today's date.

const { test } = require('node:test');
const assert = require('node:assert');
const { coolingView } = require('../lib/engine-registry');

test('prints the local hh:mm of cooling_until with the recorded reason', () => {
  const until = new Date(2026, 0, 15, 14, 32).toISOString();
  const view = coolingView({ health: { status: 'cooling', cooling_until: until, cooling_reason: 'connection dropped' } });
  assert.deepEqual(view, {
    until,
    reason: 'connection dropped',
    text: 'cooling until 14:32 (connection dropped)',
  });
});

test('pads single-digit hours and minutes to two digits', () => {
  const until = new Date(2026, 0, 15, 9, 5).toISOString();
  const view = coolingView({ health: { status: 'cooling', cooling_until: until } });
  assert.equal(view.text, 'cooling until 09:05 (stalled)');
  assert.equal(view.reason, 'stalled');
  assert.equal(view.until, until);
});

test('an engine with no cooling_until prints "later" and a null until', () => {
  const view = coolingView({ health: { status: 'cooling', cooling_reason: 'stalled' } });
  assert.equal(view.until, null);
  assert.equal(view.text, 'cooling until later (stalled)');
});

test('a missing engine or health block does not throw and falls back to the defaults', () => {
  assert.deepEqual(coolingView(null), { until: null, reason: 'stalled', text: 'cooling until later (stalled)' });
  assert.deepEqual(coolingView(undefined), { until: null, reason: 'stalled', text: 'cooling until later (stalled)' });
  assert.deepEqual(coolingView({}), { until: null, reason: 'stalled', text: 'cooling until later (stalled)' });
});

test('a blank cooling_reason falls back to stalled', () => {
  const until = new Date(2026, 0, 15, 8, 0).toISOString();
  const view = coolingView({ health: { status: 'cooling', cooling_until: until, cooling_reason: '' } });
  assert.equal(view.reason, 'stalled');
  assert.equal(view.text, 'cooling until 08:00 (stalled)');
});

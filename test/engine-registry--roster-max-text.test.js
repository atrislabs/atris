'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rosterMaxText } = require('../lib/engine-registry');

test('rosterMaxText renders whole hours, whole minutes, and bare seconds', () => {
  assert.equal(rosterMaxText(7200), 'max 2h');
  assert.equal(rosterMaxText(1200), 'max 20 min');
  assert.equal(rosterMaxText(90), 'max 90s');
});

test('rosterMaxText picks the largest clean unit at boundaries', () => {
  assert.equal(rosterMaxText(3600), 'max 1h');
  assert.equal(rosterMaxText(60), 'max 1 min');
  assert.equal(rosterMaxText(61), 'max 61s');
  assert.equal(rosterMaxText(3599), 'max 3599s');
  // Seconds that arrive as a string still render.
  assert.equal(rosterMaxText('120'), 'max 2 min');
});

test('rosterMaxText returns empty text for unusable input', () => {
  for (const bad of [0, -30, NaN, Infinity, -Infinity, undefined, null, 'abc', '']) {
    assert.equal(rosterMaxText(bad), '', `expected "" for ${String(bad)}`);
  }
});

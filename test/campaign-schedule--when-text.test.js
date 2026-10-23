'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { whenText } = require('../lib/campaign-schedule');

const MIN = 60 * 1000;

// whenText renders local time, so expected values are rebuilt from Date the
// same way at runtime. That keeps every assert true in any timezone the
// checker runs this file in.
function expectedText(ms) {
  const at = new Date(ms);
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

test('whenText renders a fixed timestamp as "<day> HH:MM"', () => {
  const ms = Date.UTC(2026, 9, 23, 18, 30); // fixed point in time, no clock reads
  const out = whenText(ms);
  assert.strictEqual(out, expectedText(ms));
  assert.match(out, / \d{2}:\d{2}$/);
});

test('whenText zero-pads single-digit hours and minutes', () => {
  // Scan one fixed day minute by minute until local time has a one-digit hour
  // and minute; guaranteed to exist (e.g. 01:01) in every timezone.
  const base = Date.UTC(2026, 0, 5, 12, 0);
  let ms = null;
  for (let i = 0; i < 24 * 60; i++) {
    const candidate = base + i * MIN;
    const at = new Date(candidate);
    if (at.getHours() < 10 && at.getMinutes() < 10) { ms = candidate; break; }
  }
  assert.notStrictEqual(ms, null, 'expected a single-digit local time in one day');

  const out = whenText(ms);
  const at = new Date(ms);
  const time = `0${at.getHours()}:0${at.getMinutes()}`;
  assert.ok(out.endsWith(` ${time}`), `expected "${out}" to end with " ${time}"`);
  assert.strictEqual(out, expectedText(ms));
});

test('whenText returns a "Invalid Date NaN:NaN" style string for bad input instead of throwing', () => {
  for (const bad of [undefined, NaN, 'not a number']) {
    const out = whenText(bad);
    assert.strictEqual(typeof out, 'string');
    assert.match(out, /NaN:NaN$/, `expected NaN time for input ${String(bad)}`);
  }
});

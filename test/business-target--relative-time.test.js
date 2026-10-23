'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let relativeTime;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-02T00:00:00Z');

// ISO string for an instant `deltaMs` away from the fixed NOW.
const at = (deltaMs) => new Date(NOW + deltaMs).toISOString();

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-relative-time-'));
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  ({ relativeTime } = require('../lib/business-target'));
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('relativeTime words a future time as "in ..." and a past time as "... ago"', () => {
  assert.strictEqual(relativeTime(at(9 * HOUR), NOW), 'in 9 h');
  assert.strictEqual(relativeTime(at(-6 * HOUR), NOW), '6 h ago');
  assert.strictEqual(relativeTime(at(45 * MIN), NOW), 'in 45 min');
  assert.strictEqual(relativeTime(at(-45 * MIN), NOW), '45 min ago');
  assert.strictEqual(relativeTime(at(10 * DAY), NOW), 'in 10 days');
  assert.strictEqual(relativeTime(at(-10 * DAY), NOW), '10 days ago');
});

test('relativeTime reads the offset in the timestamp, not the machine time zone', () => {
  assert.strictEqual(relativeTime('2026-10-02T09:00:00+00:00', NOW), 'in 9 h');
  assert.strictEqual(relativeTime('2026-10-02T14:30:00+05:30', NOW), 'in 9 h');
  assert.strictEqual(relativeTime('2026-10-01T18:00:00Z', NOW), '6 h ago');
  // A date with no time is read as midnight UTC.
  assert.strictEqual(relativeTime('2026-10-03', NOW), 'in 24 h');
});

test('relativeTime says "just now" inside half a minute and switches to minutes after', () => {
  assert.strictEqual(relativeTime(at(0), NOW), 'just now');
  assert.strictEqual(relativeTime(at(29 * SEC), NOW), 'just now');
  assert.strictEqual(relativeTime(at(-29 * SEC), NOW), 'just now');
  assert.strictEqual(relativeTime(at(30 * SEC), NOW), 'in 1 min');
  assert.strictEqual(relativeTime(at(-31 * SEC), NOW), '1 min ago');
});

test('relativeTime moves from minutes to hours at 90 minutes', () => {
  assert.strictEqual(relativeTime(at(89 * MIN), NOW), 'in 89 min');
  assert.strictEqual(relativeTime(at(90 * MIN), NOW), 'in 2 h');
  assert.strictEqual(relativeTime(at(-89 * MIN), NOW), '89 min ago');
  assert.strictEqual(relativeTime(at(-90 * MIN), NOW), '2 h ago');
});

test('relativeTime moves from hours to days at 48 hours', () => {
  assert.strictEqual(relativeTime(at(48 * HOUR - MIN), NOW), 'in 48 h');
  assert.strictEqual(relativeTime(at(48 * HOUR), NOW), 'in 2 days');
  assert.strictEqual(relativeTime(at(-(48 * HOUR - MIN)), NOW), '48 h ago');
  assert.strictEqual(relativeTime(at(-48 * HOUR), NOW), '2 days ago');
});

test('relativeTime returns an empty string for missing or unreadable input', () => {
  assert.strictEqual(relativeTime(undefined, NOW), '');
  assert.strictEqual(relativeTime(null, NOW), '');
  assert.strictEqual(relativeTime('', NOW), '');
  assert.strictEqual(relativeTime('not a date', NOW), '');
  assert.strictEqual(relativeTime('2026-13-45T99:99:99Z', NOW), '');
  // Unreadable input is rejected before the clock is looked at.
  assert.strictEqual(relativeTime('not a date'), '');
  assert.strictEqual(relativeTime(), '');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { activeWindowStartDay } = require('../lib/team-presence');

test('activeWindowStartDay includes the supplied day in its seven-day window', () => {
  const nowMs = new Date(2026, 0, 20, 12).getTime();

  assert.strictEqual(activeWindowStartDay(nowMs), '2026-01-14');
  assert.strictEqual(activeWindowStartDay(nowMs / 1000), '2026-01-14');
  assert.strictEqual(activeWindowStartDay(String(nowMs / 1000)), '2026-01-14');
  assert.strictEqual(activeWindowStartDay('2026-01-20T12:00:00'), '2026-01-14');
});

test('activeWindowStartDay crosses year boundaries and includes leap day', () => {
  assert.strictEqual(
    activeWindowStartDay(new Date(2026, 0, 3, 12).getTime()),
    '2025-12-28',
  );
  assert.strictEqual(
    activeWindowStartDay(new Date(2024, 2, 6, 12).getTime()),
    '2024-02-29',
  );
});

test('activeWindowStartDay rejects a symbol timestamp', () => {
  assert.throws(() => activeWindowStartDay(Symbol('invalid timestamp')), TypeError);
});

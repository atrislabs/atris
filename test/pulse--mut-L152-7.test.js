'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPulseScorecardRow } = require('../lib/pulse');

test('scorecard preserves the supplied event timestamp', () => {
  const ts = '2024-01-15T12:00:00.000Z';
  const row = buildPulseScorecardRow({ ts, reward: 1, verifyPassed: true });

  assert.strictEqual(row.ts, ts);
});

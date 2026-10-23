'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const pulse = require('../lib/pulse');

test('normalizeCronCadence maps 24h to a once-a-day cron, not an error', () => {
  assert.strictEqual(pulse.normalizeCronCadence('24h'), '23 0 * * *');
});

test('normalizeCronCadence maps sub-day hour cadences to interval crons', () => {
  assert.strictEqual(pulse.normalizeCronCadence('1h'), '23 */1 * * *');
  assert.strictEqual(pulse.normalizeCronCadence('2h'), '23 */2 * * *');
  assert.strictEqual(pulse.normalizeCronCadence('23h'), '23 */23 * * *');
});

test('normalizeCronCadence rejects hour cadences above 24', () => {
  assert.throws(() => pulse.normalizeCronCadence('25h'), /invalid cadence/);
});

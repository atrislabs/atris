'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCronCadence } = require('../lib/pulse');

test('one-minute cadence produces an every-minute schedule', () => {
  assert.strictEqual(normalizeCronCadence('1m'), '*/1 * * * *');
});

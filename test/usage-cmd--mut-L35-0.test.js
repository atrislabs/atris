'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderUsage } = require('../commands/usage');

test('structured model totals remain readable as JSON', () => {
  const output = renderUsage({ models: { alpha: { requests: 7, credits: 125 } } });

  assert.match(output, /"requests"\s*:\s*7/);
});

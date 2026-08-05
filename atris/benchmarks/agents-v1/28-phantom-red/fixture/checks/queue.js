'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drainMs } = require('../queue');

test('drains within budget', () => {
  const contentionMs = Number(process.env.SIM_LOAD_MS || 0);
  const elapsed = drainMs(['a', 'b', 'c']) + contentionMs;
  assert.ok(elapsed <= 50, `drained in ${elapsed}ms, budget is 50ms`);
});

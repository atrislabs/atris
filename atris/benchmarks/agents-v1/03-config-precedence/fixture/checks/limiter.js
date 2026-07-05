'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMaxRequests } = require('../limiter');

test('an env override below the file config wins as a safety cap', () => {
  const prior = process.env.RATE_LIMIT_MAX;
  process.env.RATE_LIMIT_MAX = '5';
  try {
    assert.equal(resolveMaxRequests(), 5);
  } finally {
    if (prior === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = prior;
  }
});

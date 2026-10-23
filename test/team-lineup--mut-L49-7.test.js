'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readLineupSafe } = require('../lib/team-lineup');

test('readLineupSafe returns the error message without the error type prefix', () => {
  assert.deepStrictEqual(readLineupSafe(null, new Date('2020-01-01T00:00:00Z')), {
    ok: false,
    error: 'The "path" argument must be of type string. Received null',
    jobs: [],
    team: [],
  });
});

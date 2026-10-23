'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { threeWayCompare } = require('../lib/manifest');

test('a file deleted on both sides is not a pending local deletion', () => {
  const baseline = {
    files: {
      '/notes.md': { hash: 'abc123', size: 12 },
    },
  };

  const result = threeWayCompare({}, {}, baseline);

  assert.strictEqual(result.deletedLocal.includes('/notes.md'), false);
});

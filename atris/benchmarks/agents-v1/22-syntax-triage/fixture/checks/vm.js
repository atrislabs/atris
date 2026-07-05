'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../vm');

test('runs a small stack program', () => {
  const result = run([
    { op: 'push', value: 2 },
    { op: 'push', value: 3 },
    { op: 'add' },
    { op: 'push', value: 4 },
    { op: 'mul' },
  ]);
  assert.equal(result, 20);
});

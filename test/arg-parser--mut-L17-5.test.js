'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFlag } = require('../lib/arg-parser');

test('readFlag ignores inherited tokens beyond the argument array length', () => {
  const args = ['--other'];
  const prototype = Object.create(Array.prototype);
  prototype[1] = '--owner=phantom';
  Object.setPrototypeOf(args, prototype);

  assert.equal(readFlag(args, '--owner', 'fallback'), 'fallback');
});

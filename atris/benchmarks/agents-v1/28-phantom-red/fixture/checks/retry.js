'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backoffMs } = require('../retry');

test('backoff doubles per attempt', () => {
  assert.equal(backoffMs(1), 100);
  assert.equal(backoffMs(2), 200);
  assert.equal(backoffMs(3), 400);
});

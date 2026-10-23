'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { errorText } = require('../lib/business-target');

test('errorText explains a 404 response without backend detail', () => {
  assert.equal(
    errorText({ status: 404, data: {} }),
    'backend rolling out, try again shortly'
  );
});

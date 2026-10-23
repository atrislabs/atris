'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskProofState } = require('../lib/task-proof');

test('a changed source file without validation is insufficient proof', () => {
  assert.equal(taskProofState('Updated src/parser.js to handle missing arguments').ok, false);
});

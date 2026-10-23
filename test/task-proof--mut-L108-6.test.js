'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskProofState } = require('../lib/task-proof');

test('mentioning a screenshot without evidence does not qualify as proof', () => {
  const state = taskProofState('I took a screenshot of the updated settings page');
  assert.strictEqual(state.ok, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { taskBuilder } = require('../lib/review-integrity');

test('taskBuilder returns null when the task is null', () => {
  assert.equal(taskBuilder(null), null);
});

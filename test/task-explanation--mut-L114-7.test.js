'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskExplanation } = require('../lib/task-explanation');

test('uses the reviewed change when the task has no authored finish', () => {
  const explanation = taskExplanation({
    title: 'Repair password reset',
    review: { result: { changed: 'Customers can reset passwords by email' } },
  });

  assert.match(explanation.done_looks_like, /Customers can reset passwords by email/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskExplanation } = require('../lib/task-explanation');

test('uses the recorded result as the finish when no exit condition is supplied', () => {
  const explanation = taskExplanation({
    title: 'Repair password reset',
    metadata: { result: 'Customers can reset passwords' },
  });

  assert.match(explanation.done_looks_like, /Customers can reset passwords/);
});

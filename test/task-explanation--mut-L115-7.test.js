'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskExplanation } = require('../lib/task-explanation');

test('a review landing supplies the finish when no authored finish or review summary exists', () => {
  const result = taskExplanation({
    title: 'Ship password reset',
    status: 'review',
    metadata: {},
    review: {
      landing: { happened: 'People can reset their passwords by email.' },
    },
  });

  assert.equal(result.done_looks_like, 'People can reset their passwords by email.');
});

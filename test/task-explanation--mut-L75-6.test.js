'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitDoneLooksLike } = require('../lib/task-explanation');

test('a non-object sources value does not suppress the authored finish line', () => {
  assert.equal(explicitDoneLooksLike({
    explanation: {
      sources: 'legacy',
      done_looks_like: 'The saved report opens correctly.',
    },
  }), 'The saved report opens correctly.');
});

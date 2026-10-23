'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskProofState } = require('../lib/task-proof');

test('a named source artifact is meaningful without a result pair', () => {
  assert.strictEqual(taskProofState('Artifact: src/parser.js').ok, true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { taskBuilder } = require('../lib/review-integrity');

test('a proof payload identifies the builder when no owner is stamped', () => {
  const task = {
    metadata: {},
    events: [
      { event_type: 'proof_ready', payload: { actor: 'Codex' } },
    ],
  };

  assert.strictEqual(taskBuilder(task), 'codex');
});

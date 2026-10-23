'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missionProofPayload } = require('../commands/human-missions');

test('structured proof changes survive a plain text proof summary', () => {
  const proof = missionProofPayload({
    title: 'Update the service page',
    proof: 'The service descriptions were updated.',
    result: {
      proof: {
        goal: 'Update the service page',
        changed: ['service descriptions'],
      },
    },
  });

  assert.deepEqual(proof.changed, ['service descriptions']);
});

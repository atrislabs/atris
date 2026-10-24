'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupPicksBySignature } = require('../commands/router');

test('negative feedback counts as a bad pick without a runtime error', () => {
  const groups = groupPicksBySignature([
    { pick_id: 'incorrect-answer', lane: 'fast', message: 'what is gravity' },
    {
      event: 'outcome',
      pick_id: 'incorrect-answer',
      ok: false,
      message: 'The answer confused gravity with magnetism.',
    },
  ]);
  assert.equal(groups.get('what is|fast').bad_picks.length, 1);
});

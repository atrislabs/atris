'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupPicksBySignature } = require('../commands/router');

test('a pick with an error is not itself a failed outcome', () => {
  const groups = groupPicksBySignature([
    {
      pick_id: 'pick-with-error',
      lane: 'fast',
      message: 'what is a queue',
      ok: false,
      error: 'routing failed',
    },
  ]);

  assert.equal(groups.get('what is|fast').bad_picks.length, 0);
});

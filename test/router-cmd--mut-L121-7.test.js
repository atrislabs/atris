'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupPicksBySignature } = require('../commands/router');

test('outcomes carrying lane and message fields are not counted as picks', () => {
  const pick = { pick_id: 'pick-1', lane: 'fast', message: 'explain this example' };
  const outcome = { ...pick, event: 'outcome', ok: false };

  assert.deepEqual(groupPicksBySignature([pick, outcome]), new Map([
    ['explain this|fast', {
      signature: 'explain this|fast',
      lane: 'fast',
      words: ['explain', 'this'],
      picks: [pick],
      bad_picks: [pick],
    }],
  ]));
});

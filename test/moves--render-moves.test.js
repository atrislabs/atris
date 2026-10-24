'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderMoves } = require('../commands/moves');

// renderMoves is pure: it takes move objects and returns text. No fs, no env,
// no clock, so these tests need no temp dirs or env scrubbing.

test('renderMoves lists each move with its number, why, and id, then the approve/kill hints', () => {
  const moves = [
    { id: 'm_alpha', title: 'Write the onboarding doc', why: 'new users stall at step one' },
    { id: 'm_beta', title: 'Fix the flaky login test', why: 'it blocks every merge' },
  ];

  const out = renderMoves(moves);

  assert.strictEqual(out, [
    '',
    'your next moves',
    '',
    '  1. Write the onboarding doc',
    '     why: new users stall at step one   id: m_alpha',
    '',
    '  2. Fix the flaky login test',
    '     why: it blocks every merge   id: m_beta',
    '',
    '  approve:  atris moves --approve <id|N>   seed it into the loop',
    '  kill:     atris moves --kill <id|N>      stop suggesting it',
    '  (use the id when you act later; the numbered order can shift)',
    '',
  ].join('\n'));
});

test('renderMoves numbers moves from 1 in the order given and keeps each id with its own move', () => {
  const moves = [
    { id: 'm_one', title: 'First', why: 'why one' },
    { id: 'm_two', title: 'Second', why: 'why two' },
    { id: 'm_three', title: 'Third', why: 'why three' },
  ];

  const out = renderMoves(moves);
  const lines = out.split('\n');

  assert.strictEqual(lines[3], '  1. First');
  assert.strictEqual(lines[4], '     why: why one   id: m_one');
  assert.strictEqual(lines[6], '  2. Second');
  assert.strictEqual(lines[7], '     why: why two   id: m_two');
  assert.strictEqual(lines[9], '  3. Third');
  assert.strictEqual(lines[10], '     why: why three   id: m_three');
  assert.strictEqual(out.match(/^ {2}\d\. /gm).length, 3);
});

test('renderMoves with no moves shows the empty-queue hint instead of a list', () => {
  const out = renderMoves([]);

  assert.strictEqual(out, [
    '',
    'your next moves',
    '',
    '  nothing queued. add an item to ROADMAP.md under "## Open loop items",',
    '  or jot an idea with `atris log`.',
    '',
  ].join('\n'));
  assert.strictEqual(out.includes('id:'), false);
  assert.strictEqual(out.includes('approve:'), false);
});

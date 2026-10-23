'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { replayRows } = require('../lib/gm-season');

// replayRows is pure: plays in, row keys out. No clock, no disk, no env.
function play(member, club = undefined) {
  return club === undefined ? { member, kind: 'landed' } : { member, club, kind: 'landed' };
}

test('replayRows ranks members by play count, ties by name, and ignores input order', () => {
  const plays = [
    play('dee'),
    play('bo'),
    play('ana'),
    play('cy'),
    play('ana'),
    play('bo'),
    play('ana'),
    play('cy'),
  ];
  assert.deepStrictEqual(replayRows(plays), ['ana', 'bo', 'cy', 'dee']);
  assert.deepStrictEqual(replayRows(plays.slice().reverse()), ['ana', 'bo', 'cy', 'dee']);
});

test('replayRows caps the rows at limit, and at ten by default', () => {
  const plays = [play('ana'), play('ana'), play('bo'), play('cy')];
  assert.deepStrictEqual(replayRows(plays, { limit: 2 }), ['ana', 'bo']);
  assert.deepStrictEqual(replayRows(plays, { limit: 0 }), []);

  const twelve = Array.from({ length: 12 }, (_, i) => play(`m${String(i).padStart(2, '0')}`));
  const defaultRows = replayRows(twelve);
  assert.equal(defaultRows.length, 10);
  assert.deepStrictEqual(defaultRows, Array.from({ length: 10 }, (_, i) => `m${String(i).padStart(2, '0')}`));
});

test('replayRows keys by club in league mode, labels missing clubs "?", and skips missing members', () => {
  const plays = [
    play('ana', 'alpha'),
    play('bo', 'alpha'),
    play('ana', 'beta'),
    play('cy'),
  ];
  assert.deepStrictEqual(replayRows(plays, { byClub: true }), ['alpha', '?', 'beta']);

  const noMember = [play(''), play(null), play('ana')];
  assert.deepStrictEqual(replayRows(noMember), ['ana']);
});

test('replayRows returns no rows for empty input', () => {
  assert.deepStrictEqual(replayRows(), []);
  assert.deepStrictEqual(replayRows([]), []);
  assert.deepStrictEqual(replayRows([], { byClub: true }), []);
});

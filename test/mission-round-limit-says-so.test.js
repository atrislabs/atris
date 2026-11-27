// Seen 2026-11-17: three 3-hour runs stopped at 36 rounds after about 1.5 hours, still read
// "running", and nothing said why. A run ended by its round limit with time left says so.
const test = require('node:test');
const assert = require('node:assert');
const { roundLimitEnding } = require('../commands/mission');

test('a run the round limit ends with time left says how many rounds and minutes', () => {
  const early = roundLimitEnding('max-ticks-reached', 10800, 5580, 36);
  assert.deepEqual({ rounds: early.rounds, minutes_left: early.minutes_left }, { rounds: 36, minutes_left: 87 });
  assert.equal(early.line, 'Stopped early: the round limit (36) was reached with 87 minutes of the time left.');
});

test('a run that used its time, or ended for another reason, adds nothing', () => {
  assert.equal(roundLimitEnding('max-ticks-reached', 10800, 10770, 36), null, 'under a minute left is the time running out');
  assert.equal(roundLimitEnding('paused', 10800, 600, 3), null);
  assert.equal(roundLimitEnding('max-ticks-reached', null, 600, 1), null, 'a run with no time limit');
});

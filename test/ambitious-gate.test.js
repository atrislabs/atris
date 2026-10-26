'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signP } = require('../atris/experiments/ambitious-skill/gate.js');

test('sign test matches hand-computed binomial tails', () => {
  // 10 wins, 4 losses: (1001 + 364 + 91 + 14 + 1) / 2^14
  assert.equal(signP(10, 4), 1471 / 16384);
  // 15 of 20 is the first count that clears 0.05
  assert.ok(signP(15, 5) < 0.05);
  assert.ok(signP(14, 6) > 0.05);
  // no decided pairs means no evidence at all
  assert.equal(signP(0, 0), 1);
});

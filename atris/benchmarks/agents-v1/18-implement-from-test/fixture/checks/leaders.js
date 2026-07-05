'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { topScores } = require('../leaders');

test('returns the highest scores in order', () => {
  const entries = [
    { name: 'amy', score: 40 },
    { name: 'ben', score: 90 },
    { name: 'cara', score: 70 },
    { name: 'dan', score: 90 },
  ];
  assert.deepEqual(topScores(entries, 2), ['ben', 'dan']);
});

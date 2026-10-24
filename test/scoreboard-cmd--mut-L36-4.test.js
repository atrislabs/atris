'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../commands/scoreboard');

test('score keeps the first best day when later days tie its count', () => {
  const days = [
    { date: '2024-06-01', count: 12 },
    { date: '2024-06-02', count: 12 },
    { date: '2024-06-03', count: 1 },
  ];

  assert.deepStrictEqual(score(days, '2024-06-03'), {
    today: 1,
    best: { date: '2024-06-01', count: 12 },
    streak: 3,
  });
});

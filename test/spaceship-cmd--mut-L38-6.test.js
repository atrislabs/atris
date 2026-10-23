'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planLines } = require('../commands/spaceship');

test('a positional number does not set the hours when --hours is absent', () => {
  const previousOperator = process.env.ATRIS_OPERATOR;
  try {
    process.env.ATRIS_OPERATOR = 'Robin';
    assert.deepStrictEqual(planLines(['2', '--no-email']), [
      'hey robin, I can keep working here for 4 hours.',
      '',
      'next: atris spaceship --yes',
    ]);
  } finally {
    if (previousOperator === undefined) delete process.env.ATRIS_OPERATOR;
    else process.env.ATRIS_OPERATOR = previousOperator;
  }
});

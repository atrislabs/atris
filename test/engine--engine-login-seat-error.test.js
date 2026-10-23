'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { engineLoginSeatError } = require('../commands/engine');

const expected = 'seat names are letters, numbers, underscores - like personal or work';

test('engineLoginSeatError returns the seat naming guidance without arguments', () => {
  assert.strictEqual(engineLoginSeatError(), expected);
});

test('engineLoginSeatError keeps the same guidance for supplied and empty seat names', () => {
  for (const seat of ['personal', 'work', '', undefined, null, 'invalid/seat']) {
    assert.strictEqual(engineLoginSeatError(seat), expected);
  }
});

test('engineLoginSeatError does not inspect or stringify an unexpected argument', () => {
  const seat = {
    [Symbol.toPrimitive]() {
      throw new Error('seat must not be coerced');
    },
  };

  assert.strictEqual(engineLoginSeatError(seat), expected);
});

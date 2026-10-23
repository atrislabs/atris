'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { withWishAnswerAuditContext } = require('../lib/wish-audit');

test('returns the callback result unchanged and invokes it once without arguments', () => {
  const context = { answer: 'use the existing folder' };
  const result = { accepted: true };
  let calls = 0;

  const actual = withWishAnswerAuditContext(context, (...args) => {
    calls += 1;
    assert.deepStrictEqual(args, []);
    return result;
  });

  assert.strictEqual(actual, result);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(context, { answer: 'use the existing folder' });
});

test('accepts empty contexts and preserves falsy and undefined callback results', () => {
  for (const context of [undefined, null, false, 0, '', {}]) {
    for (const result of [undefined, null, false, 0, '']) {
      assert.strictEqual(withWishAnswerAuditContext(context, () => result), result);
    }
  }
});

test('nested calls return their own results in synchronous callback order', () => {
  const order = [];
  const innerResult = { inner: true };
  const outerResult = { outer: true };

  const actual = withWishAnswerAuditContext({ answer: 'outer' }, () => {
    order.push('outer before');
    const inner = withWishAnswerAuditContext({ answer: 'inner' }, () => {
      order.push('inner');
      return innerResult;
    });
    assert.strictEqual(inner, innerResult);
    order.push('outer after');
    return outerResult;
  });

  assert.strictEqual(actual, outerResult);
  assert.deepStrictEqual(order, ['outer before', 'inner', 'outer after']);
});

test('propagates the original callback error and permits subsequent calls', () => {
  const failure = new Error('callback failed');

  assert.throws(() => withWishAnswerAuditContext({ answer: 'answer' }, () => {
    throw failure;
  }), (error) => error === failure);

  assert.throws(() => withWishAnswerAuditContext(null, null), TypeError);
  assert.strictEqual(withWishAnswerAuditContext(null, () => 'finished'), 'finished');
});

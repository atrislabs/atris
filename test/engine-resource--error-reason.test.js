const test = require('node:test');
const assert = require('node:assert');

const { errorReason } = require('../lib/engine-resource');

test('error reason is the first line of the error, trimmed', () => {
  assert.equal(errorReason({ error: 'engine could not start\nstack frame one\nstack frame two' }), 'engine could not start');
  assert.equal(errorReason({ error: '  spaced reason  \nmore' }), 'spaced reason');
});

test('error reason skips blank lines before the first real line', () => {
  assert.equal(errorReason({ error: '\n   \n\t\nreal failure detail\nignored tail' }), 'real failure detail');
});

test('error reason caps at 200 characters', () => {
  const long = `x${'y'.repeat(300)}`;
  const reason = errorReason({ error: long });
  assert.equal(reason.length, 200);
  assert.equal(reason, long.slice(0, 200));
});

test('error reason is empty for missing or non-string errors', () => {
  assert.equal(errorReason(null), '');
  assert.equal(errorReason(undefined), '');
  assert.equal(errorReason({}), '');
  assert.equal(errorReason({ error: 42 }), '');
  assert.equal(errorReason({ error: '' }), '');
  assert.equal(errorReason({ error: '   \n  \n\t ' }), '');
});

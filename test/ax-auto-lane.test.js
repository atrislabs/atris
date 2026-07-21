const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LONG_INPUT_MIN_CHARS,
  SHORT_LOOKUP_MAX_CHARS,
  pickLane,
} = require('../lib/ax-auto-lane');

test('pickLane sends short factual lookups to fast', () => {
  assert.equal(pickLane('what is the capital of france?').lane, 'fast');
  assert.equal(pickLane('please list the primary colors').lane, 'fast');
});

test('pickLane includes the short lookup boundary in fast', () => {
  const message = `define ${'x'.repeat(SHORT_LOOKUP_MAX_CHARS - 7)}`;
  assert.equal(message.length, SHORT_LOOKUP_MAX_CHARS);
  assert.equal(pickLane(message).lane, 'fast');
});

test('pickLane sends a lookup beyond the short boundary to pro', () => {
  const message = `define ${'x'.repeat(SHORT_LOOKUP_MAX_CHARS - 6)}`;
  assert.equal(message.length, SHORT_LOOKUP_MAX_CHARS + 1);
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane sends heavy reasoning requests to max', () => {
  assert.equal(pickLane('compare the tradeoffs of queues and event streams').lane, 'max');
  assert.equal(pickLane('planning an offline-first sync architecture').lane, 'max');
});

test('pickLane sends multiple questions to max', () => {
  assert.equal(pickLane('what shipped? who owns the follow-up?').lane, 'max');
});

test('pickLane sends input over the long boundary to max', () => {
  const message = 'x'.repeat(LONG_INPUT_MIN_CHARS + 1);
  assert.equal(pickLane(message).lane, 'max');
});

test('pickLane leaves the exact long boundary in pro', () => {
  const message = 'x'.repeat(LONG_INPUT_MIN_CHARS);
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane sends fenced bounded fixes to code-fast', () => {
  const message = 'fix this function:\n```js\nreturn value + 1;\n```';
  assert.equal(pickLane(message).lane, 'code-fast');
});

test('pickLane sends stack trace debugging to code-fast', () => {
  const message = 'debugging this trace:\nTypeError: value is not a function\n    at run (/tmp/app.js:4:2)';
  assert.equal(pickLane(message).lane, 'code-fast');
});

test('pickLane requires an edit verb with code context', () => {
  const message = 'explain this:\n```js\nreturn value + 1;\n```';
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane defaults general requests to pro', () => {
  assert.equal(pickLane('write a friendly project update').lane, 'pro');
  assert.deepEqual(pickLane(''), { lane: 'pro', reason: 'pro fits this general request.' });
});

test('pickLane reasons are lowercase sentences', () => {
  for (const message of [
    'what time is it?',
    'analyze this proposal',
    'fix this:\n```js\nthrow new Error();\n```',
    'draft a reply',
  ]) {
    const { reason } = pickLane(message);
    assert.equal(reason, reason.toLowerCase());
    assert.match(reason, /^[a-z][^.]*\.$/);
  }
});

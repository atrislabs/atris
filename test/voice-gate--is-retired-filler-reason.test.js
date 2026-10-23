'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { isRetiredFillerReason } = require('../lib/voice-gate');

test('isRetiredFillerReason flags each retired canned reason as retired', () => {
  const retired = [
    'It makes the result understandable before a human accepts or rejects it.',
    'It proves the workflow works in the place people actually use it.',
    'It turns the mission into a concrete result a human can accept, reject, or run again.',
    'It turns the task title into a concrete result the human can approve.',
    'It gives the human a repeatable check before approval.',
    'It keeps real-world side effects behind a clear human decision.',
    'It keeps private data out of the fast human decision screen.',
    'It lets the operator see the next command without hunting.',
    'It stops old approvals from running after their context has gone stale.',
    'This makes the work easier to judge.',
  ];
  for (const reason of retired) {
    assert.strictEqual(isRetiredFillerReason(reason), true, reason);
  }
});

test('isRetiredFillerReason ignores surrounding and repeated whitespace before matching', () => {
  assert.strictEqual(isRetiredFillerReason('  This makes the work easier to judge.\n'), true);
  assert.strictEqual(
    isRetiredFillerReason('It gives the human\n  a repeatable   check before approval.'),
    true,
  );
});

test('isRetiredFillerReason keeps real, specific reasons and near misses', () => {
  const kept = [
    'It cuts the approval queue from nine items to two.',
    'It fixes the login redirect that sent people to a blank page.',
    // Missing the closing period means it is not the canned text.
    'This makes the work easier to judge',
    // Lowercase is not the canned text either; the match is exact.
    'this makes the work easier to judge.',
    // Extra words around the canned sentence mean it carries a real why.
    'This makes the work easier to judge. It also cuts review time.',
  ];
  for (const reason of kept) {
    assert.strictEqual(isRetiredFillerReason(reason), false, reason);
  }
});

test('isRetiredFillerReason treats empty and missing input as not retired', () => {
  assert.strictEqual(isRetiredFillerReason(''), false);
  assert.strictEqual(isRetiredFillerReason('   '), false);
  assert.strictEqual(isRetiredFillerReason(null), false);
  assert.strictEqual(isRetiredFillerReason(undefined), false);
});

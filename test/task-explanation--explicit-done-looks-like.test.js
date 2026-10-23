'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { explicitDoneLooksLike } = require('../lib/task-explanation');

test('returns authored nested or flat text with whitespace normalized', () => {
  assert.strictEqual(explicitDoneLooksLike({
    explanation: { done_looks_like: '  The check\n passes\twith proof.  ' },
  }), 'The check passes with proof.');
  assert.strictEqual(explicitDoneLooksLike({
    done_looks_like: '  Run CLI --dry-run against task_state  ',
  }), 'Run CLI --dry-run against task_state');
});

test('prefers explicit nested text and falls back to flat text for derived defaults', () => {
  for (const [source, expected] of [
    ['explicit', 'Authored nested finish'],
    ['derived', 'Flat finish'],
    ['unknown', 'Flat finish'],
    [undefined, 'Flat finish'],
  ]) {
    assert.strictEqual(explicitDoneLooksLike({
      done_looks_like: 'Flat finish',
      explanation: {
        done_looks_like: 'Authored nested finish',
        sources: { done_looks_like: source },
      },
    }), expected);
  }
  assert.strictEqual(explicitDoneLooksLike({
    done_looks_like: 'Flat finish',
    explanation: { done_looks_like: ' \n\t ', sources: { done_looks_like: 'explicit' } },
  }), 'Flat finish');
});

test('returns empty text for missing metadata or an unauthored finish', () => {
  for (const metadata of [
    undefined, null, '', 'text', 0, false, {},
    { done_looks_like: null },
    { done_looks_like: ' \n\t ' },
    { explanation: null },
    { explanation: { done_looks_like: 'Derived finish', sources: { done_looks_like: 'derived' } } },
    { explanation: { done_looks_like: 'Unmarked finish', sources: {} } },
    { exit_condition: 'Separate exit condition', verify: 'node check.js' },
  ]) {
    assert.strictEqual(explicitDoneLooksLike(metadata), '');
  }
});

test('coerces non-null field values to text without adding punctuation', () => {
  assert.strictEqual(explicitDoneLooksLike({ done_looks_like: 0 }), '0');
  assert.strictEqual(explicitDoneLooksLike({ done_looks_like: false }), 'false');
  assert.strictEqual(explicitDoneLooksLike({
    explanation: { done_looks_like: 42 },
  }), '42');
});

'use strict';

// A table cell reads "<engine> · <model label>": the tool, a middle dot,
// and the friendly model name, or "own default" when the tool picks its
// model itself. An empty engine renders as an empty cell, never a stray dot.

const test = require('node:test');
const assert = require('node:assert');
const { engineModelText } = require('../lib/roster-models');

test('a pinned model shows as "<engine> · <model label>"', () => {
  assert.strictEqual(engineModelText('codex', 'gpt-6-sol'), 'codex · gpt-6-sol');
  assert.strictEqual(engineModelText('claude', 'claude-opus-5-5'), 'claude · opus 5.5');
  assert.strictEqual(engineModelText('claude', 'claude-sonnet-5-20260201'), 'claude · sonnet 5');
  assert.strictEqual(engineModelText('grok', 'grok-4-build-fast'), 'grok · grok 4 fast');
});

test('no model, or a blank one, reads "own default" and the engine is trimmed', () => {
  assert.strictEqual(engineModelText('devin'), 'devin · own default');
  assert.strictEqual(engineModelText('codex', ''), 'codex · own default');
  assert.strictEqual(engineModelText('codex', '   '), 'codex · own default');
  assert.strictEqual(engineModelText('  grok  '), 'grok · own default');
  assert.strictEqual(engineModelText(42), '42 · own default');
});

test('an empty engine renders nothing, never a stray dot', () => {
  assert.strictEqual(engineModelText(''), '');
  assert.strictEqual(engineModelText('   '), '');
  assert.strictEqual(engineModelText(null), '');
  assert.strictEqual(engineModelText(undefined, 'gpt-6-sol'), '');
});

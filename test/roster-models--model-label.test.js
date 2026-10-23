'use strict';

// modelLabel turns a raw model name into the short label the roster view
// shows: "claude-opus-5-5" reads as "opus 5.5", grok versions keep their
// number, and names it does not know come back as written.

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelLabel } = require('../lib/roster-models');

test('modelLabel shortens claude names to family and version', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'sonnet 5');
  assert.equal(modelLabel('claude-haiku-4-5'), 'haiku 4.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'fable 5.1');
});

test('modelLabel drops the dated suffix on claude names', () => {
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'haiku 4.5');
  assert.equal(modelLabel('claude-opus-5-20251120'), 'opus 5');
});

test('modelLabel labels grok versions and the fast build', () => {
  assert.equal(modelLabel('grok-4'), 'grok 4');
  assert.equal(modelLabel('grok-4.1'), 'grok 4.1');
  assert.equal(modelLabel('grok-4.1-build-fast'), 'grok 4.1 fast');
  assert.equal(modelLabel('grok-3-build-fast'), 'grok 3 fast');
});

test('modelLabel passes through names it does not know', () => {
  assert.equal(modelLabel('gpt-6-sol'), 'gpt-6-sol');
  assert.equal(modelLabel('swe-2-max'), 'swe-2-max');
  assert.equal(modelLabel('o3'), 'o3');
});

test('modelLabel leaves near-miss names untouched', () => {
  // A three-digit minor or a trailing word breaks the pattern, so the name
  // comes back as written instead of a wrong label.
  assert.equal(modelLabel('claude-opus-5-123'), 'claude-opus-5-123');
  assert.equal(modelLabel('claude-opus-5-5-preview'), 'claude-opus-5-5-preview');
  assert.equal(modelLabel('grok-latest'), 'grok-latest');
});

test('modelLabel trims and coerces its input', () => {
  assert.equal(modelLabel('  claude-opus-5-5  '), 'opus 5.5');
  assert.equal(modelLabel('  gpt-6-sol\n'), 'gpt-6-sol');
  assert.equal(modelLabel(123), '123');
});

test('modelLabel returns an empty string for missing input', () => {
  assert.equal(modelLabel(''), '');
  assert.equal(modelLabel('   '), '');
  assert.equal(modelLabel(null), '');
  assert.equal(modelLabel(undefined), '');
  assert.equal(modelLabel(0), '');
  assert.equal(modelLabel(false), '');
});

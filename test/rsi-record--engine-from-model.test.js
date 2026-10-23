'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { engineFromModel } = require('../lib/rsi-record');

test('engineFromModel maps known model names to their recorded engine', () => {
  assert.strictEqual(engineFromModel('gpt-5-codex'), 'codex');
  assert.strictEqual(engineFromModel('swe-2-max-devin'), 'devin');
  assert.strictEqual(engineFromModel('cursor-fast'), 'cursor');
  assert.strictEqual(engineFromModel('composer-1'), 'cursor');
  assert.strictEqual(engineFromModel('antigravity-pro'), 'agy');
  assert.strictEqual(engineFromModel('agy-flash'), 'agy');
  assert.strictEqual(engineFromModel('claude-opus-5-5'), 'claude');
  assert.strictEqual(engineFromModel('sonnet'), 'claude');
  assert.strictEqual(engineFromModel('opus'), 'claude');
  assert.strictEqual(engineFromModel('haiku-5-5'), 'claude');
});

test('engineFromModel ignores case', () => {
  assert.strictEqual(engineFromModel('GPT-5-CODEX'), 'codex');
  assert.strictEqual(engineFromModel('Claude-Sonnet-5-5'), 'claude');
  assert.strictEqual(engineFromModel('COMPOSER'), 'cursor');
  assert.strictEqual(engineFromModel('Antigravity'), 'agy');
});

test('engineFromModel picks the first matching engine when a name has several', () => {
  // codex is checked before everything else
  assert.strictEqual(engineFromModel('claude-codex'), 'codex');
  // devin is checked before cursor and claude
  assert.strictEqual(engineFromModel('devin-opus'), 'devin');
  // cursor is checked before claude
  assert.strictEqual(engineFromModel('cursor-sonnet'), 'cursor');
  // agy is checked before claude
  assert.strictEqual(engineFromModel('agy-haiku'), 'agy');
});

test('engineFromModel returns null for empty or missing input', () => {
  assert.strictEqual(engineFromModel(), null);
  assert.strictEqual(engineFromModel(undefined), null);
  assert.strictEqual(engineFromModel(null), null);
  assert.strictEqual(engineFromModel(''), null);
  assert.strictEqual(engineFromModel(0), null);
  assert.strictEqual(engineFromModel(false), null);
});

test('engineFromModel returns null for unknown models so callers can fall back', () => {
  assert.strictEqual(engineFromModel('gpt-5'), null);
  assert.strictEqual(engineFromModel('gemini-3'), null);
  assert.strictEqual(engineFromModel('grok-4'), null);
  assert.strictEqual(engineFromModel('   '), null);
  assert.strictEqual(engineFromModel(12345), null);
  assert.strictEqual(engineFromModel({}), null);
  // the fallback pattern used by commands/improve.js
  assert.strictEqual(engineFromModel('mystery-model') || 'claude', 'claude');
});

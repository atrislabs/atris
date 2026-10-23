'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isClaudeFamilyModel } = require('../lib/engine-registry');

test('recognizes Claude family engines, aliases, and model names', () => {
  for (const model of [
    'claude', 'fable', 'haiku', 'opus', 'sonnet', 'opusplan', 'default',
    'opus 5.5', 'claude-sonnet-5-5', 'claude code opus',
  ]) {
    assert.strictEqual(isClaudeFamilyModel(model), true, model);
  }
});

test('handles whitespace, case, and long context suffixes', () => {
  for (const model of ['  OPUS  ', '  Claude   Code   sonnet  ', 'default[1m]', 'opus 5.5 [1m]']) {
    assert.strictEqual(isClaudeFamilyModel(model), true, model);
  }
});

test('rejects other engines even when their model name mentions Claude', () => {
  for (const model of [
    'codex', 'gpt-5.2', 'grok 4.7', 'gemini-3.8-flash',
    'opencode claude-opus-5-5', 'agy claude-opus-5-5-high',
  ]) {
    assert.strictEqual(isClaudeFamilyModel(model), false, model);
  }
});

test('returns false for empty and unrecognized inputs', () => {
  assert.strictEqual(isClaudeFamilyModel(), false);
  for (const model of [undefined, null, '', ' \t\n ', '[1m]', 'unknown-model', 'claude nonsense']) {
    assert.strictEqual(isClaudeFamilyModel(model), false, String(model));
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { engineTakesModel } = require('../lib/runner-command');

// An empty command template still takes a model: the default spawn adds --model.
test('engines with a model slot or the default launch shape return true', () => {
  assert.strictEqual(engineTakesModel('claude'), true);
  assert.strictEqual(engineTakesModel('fable'), true);
  assert.strictEqual(engineTakesModel('haiku'), true);
  assert.strictEqual(engineTakesModel('codex'), true);
  assert.strictEqual(engineTakesModel('cursor'), true);
  assert.strictEqual(engineTakesModel('devin'), true);
  assert.strictEqual(engineTakesModel('grok'), true);
  assert.strictEqual(engineTakesModel('agy'), true);
  assert.strictEqual(engineTakesModel('opencode'), true);
});

// Spelling variants resolve to the canonical engine before the slot check.
test('an alias follows the engine it names', () => {
  assert.strictEqual(engineTakesModel('antigravity'), true);
  assert.strictEqual(engineTakesModel('atris-fast'), false);
  assert.strictEqual(engineTakesModel('atris2-fast'), false);
  assert.strictEqual(engineTakesModel('atris-2-fast'), false);
  assert.strictEqual(engineTakesModel('mercury'), false);
  assert.strictEqual(engineTakesModel('composer'), false);
  assert.strictEqual(engineTakesModel('commandcode'), false);
});

test('an empty or unknown engine id returns false', () => {
  assert.strictEqual(engineTakesModel(''), false);
  assert.strictEqual(engineTakesModel('   '), false);
  assert.strictEqual(engineTakesModel('not-an-engine'), false);
  assert.strictEqual(engineTakesModel('Claude'), false);
  assert.strictEqual(engineTakesModel(undefined), false);
  assert.strictEqual(engineTakesModel(null), false);
});

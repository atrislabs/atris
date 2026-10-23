'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CLAUDE_MODEL_SPELLING } = require('../lib/model-names');

function groups(value) {
  const match = CLAUDE_MODEL_SPELLING.exec(value);
  assert.ok(match, `expected a match for ${JSON.stringify(value)}`);
  return [match[1], match[2], match[3]];
}

test('CLAUDE_MODEL_SPELLING captures family, major, and minor from a normal name', () => {
  assert.deepStrictEqual(groups('opus 5.5'), ['opus', '5', '5']);
  assert.deepStrictEqual(groups('fable 5.1'), ['fable', '5', '1']);
  assert.deepStrictEqual(groups('sonnet 5'), ['sonnet', '5', undefined]);
  assert.deepStrictEqual(groups('haiku-5-5'), ['haiku', '5', '5']);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.test('opus 5.5'), true);

  const again = CLAUDE_MODEL_SPELLING.exec('opus 5.5');
  assert.deepStrictEqual([again[1], again[2], again[3]], ['opus', '5', '5']);
});

test('CLAUDE_MODEL_SPELLING still splits names with glued or repeated separators', () => {
  assert.deepStrictEqual(groups('opus5'), ['opus', '5', undefined]);
  assert.deepStrictEqual(groups('haiku5.5'), ['haiku', '5', '5']);
  assert.deepStrictEqual(groups('haiku_4.5'), ['haiku', '4', '5']);
  assert.deepStrictEqual(groups('opus-5.5'), ['opus', '5', '5']);
  assert.deepStrictEqual(groups('opus  5.5'), ['opus', '5', '5']);
  assert.deepStrictEqual(groups('sonnet 5..2'), ['sonnet', '5', '2']);
  assert.deepStrictEqual(groups('fable_5-1'), ['fable', '5', '1']);
});

test('CLAUDE_MODEL_SPELLING rejects empty text and names it does not spell', () => {
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec(''), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.test(''), false);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('opus'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('OPUS 5.5'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('claude-opus-5-5'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('opus 5.5.1'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('opus 5.'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec(' opus 5.5'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.exec('opusplan'), null);
  assert.strictEqual(CLAUDE_MODEL_SPELLING.test('default'), false);
});

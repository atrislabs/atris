'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CLAUDE_LONG_CONTEXT } = require('../lib/model-names');

test('CLAUDE_LONG_CONTEXT matches a model name that ends with the long context tag', () => {
  const model = 'claude-opus-5-5[1m]';
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test(model), true);
  const match = CLAUDE_LONG_CONTEXT.exec(model);
  assert.ok(match);
  assert.strictEqual(match[0], '[1m]');
  assert.strictEqual(match.index, 'claude-opus-5-5'.length);
  assert.strictEqual(model.replace(CLAUDE_LONG_CONTEXT, ''), 'claude-opus-5-5');
});

test('CLAUDE_LONG_CONTEXT keeps a spaced tag and ignores a tag that is not the ending', () => {
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('opus 5.5 [1m]'), true);
  assert.strictEqual('opus 5.5 [1m]'.replace(CLAUDE_LONG_CONTEXT, ''), 'opus 5.5');
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('opus\t[1m]'), true);
  assert.strictEqual('opus\t[1m]'.replace(CLAUDE_LONG_CONTEXT, ''), 'opus');

  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('opus [1m] extra'), false);
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('opus [1M]'), false);
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('[1m]opus'), false);
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test('opus [10m]'), false);

  const doubled = 'opus [1m][1m]';
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test(doubled), true);
  assert.strictEqual(doubled.replace(CLAUDE_LONG_CONTEXT, ''), 'opus [1m]');
});

test('CLAUDE_LONG_CONTEXT rejects an empty name and throws when the value is not text', () => {
  assert.strictEqual(CLAUDE_LONG_CONTEXT.test(''), false);
  assert.strictEqual(CLAUDE_LONG_CONTEXT.exec(''), null);
  assert.strictEqual(''.replace(CLAUDE_LONG_CONTEXT, ''), '');
  assert.throws(
    () => CLAUDE_LONG_CONTEXT.test(Symbol('model')),
    { name: 'TypeError' },
  );
});

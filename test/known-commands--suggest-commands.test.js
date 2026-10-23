'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { suggestCommands } = require('../lib/known-commands');

test('suggests a command for a transposed typo and normalizes input', () => {
  assert.deepStrictEqual(suggestCommands('taks'), ['task']);
  assert.deepStrictEqual(suggestCommands('  TAKS  '), ['task']);
  assert.deepStrictEqual(suggestCommands('task'), ['task']);
});

test('context aliases return the primary suggestion before extras without duplicates', () => {
  assert.deepStrictEqual(suggestCommands('context'), ['activate', 'status']);
  assert.deepStrictEqual(suggestCommands('  CTX  '), ['activate', 'status']);
});

test('context suggestions respect the supplied command list', () => {
  assert.deepStrictEqual(suggestCommands('context', ['status']), ['status']);
  assert.deepStrictEqual(suggestCommands('ctx', ['activate']), ['activate']);
  assert.deepStrictEqual(suggestCommands('context', []), []);
});

test('custom candidates exclude private commands and break equal-distance ties by order', () => {
  assert.deepStrictEqual(suggestCommands('_task', ['_task']), []);
  assert.deepStrictEqual(suggestCommands('cat', ['bat', 'car']), ['bat']);
  assert.deepStrictEqual(suggestCommands('cat', ['car', 'bat']), ['car']);
});

test('empty, non-string, and unrelated inputs return no suggestions', () => {
  for (const input of [undefined, null, '', '   ', false, 123, {}, []]) {
    assert.deepStrictEqual(suggestCommands(input), []);
  }
  assert.deepStrictEqual(suggestCommands('zzzzzzzzzzzz'), []);
  assert.deepStrictEqual(suggestCommands('task', []), []);
});

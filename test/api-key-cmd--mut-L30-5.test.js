'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApiKeyArgs } = require('../commands/api-key');

test('parseApiKeyArgs does not iterate past the end of args', () => {
  const result = parseApiKeyArgs(['list']);
  assert.deepStrictEqual(result, {
    action: 'list',
    id: '',
    name: 'cli',
    cap: null,
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSimpleFlags } = require('../commands/interview');

test('flag followed by another flag does not take next flag as value', () => {
  const parsed = parseSimpleFlags(['--name', '--other'], ['--name']);
  assert.strictEqual(parsed.values['--name'], undefined);
});

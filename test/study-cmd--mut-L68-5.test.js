'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../commands/study');

test('topic arguments are collected through the final word', () => {
  const options = parseArgs(['ai', 'research']);
  assert.strictEqual(options.topic, 'ai research');
});

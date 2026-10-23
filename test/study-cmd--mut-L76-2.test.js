'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../commands/study');

test('a trailing --while flag requires a command argument', () => {
  assert.throws(() => parseArgs(['--while']), /--while requires/);
});

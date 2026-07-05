'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../commands/core');
require('../commands/extra');
const { commands } = require('../registry');

test('registers the core and extra commands', () => {
  assert.equal(commands.has('init'), true);
  assert.equal(commands.has('deploy'), true);
  assert.equal(commands.has('debug-dump'), false);
});

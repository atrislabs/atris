'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isClaudeSettingsPath } = require('../lib/config-guard');

test('blank and non-string values are not Claude settings paths', () => {
  for (const value of [undefined, null, false, 0, {}, [], '', ' \t\n']) {
    assert.equal(isClaudeSettingsPath(value), false);
  }
});

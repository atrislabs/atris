'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResultArgs } = require('../lib/member-result');

test('the long help flag requests help without a member', () => {
  assert.strictEqual(parseResultArgs(['--help']).help, true);
});

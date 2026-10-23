'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memberBundlePresent } = require('../lib/member-scaffold');

test('a missing member directory does not count as an installed bundle', () => {
  assert.strictEqual(memberBundlePresent(undefined), false);
});

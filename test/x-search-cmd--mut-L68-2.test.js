'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXSearchArgs } = require('../commands/x-search');

test('a trailing limit flag reports its missing value', () => {
  assert.throws(
    () => parseXSearchArgs(['agent tooling', '--limit']),
    /requires a value/,
  );
});

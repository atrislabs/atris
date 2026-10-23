'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResultArgs } = require('../lib/member-result');

test('a trailing since flag reports its missing value', () => {
  assert.throws(
    () => parseResultArgs(['film-studio', '--since']),
    /needs an iso time/,
  );
});

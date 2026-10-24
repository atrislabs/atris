'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyVerifier } = require('../lib/verifier-quality');

test('combined file and directory existence checks are rejected as proof', () => {
  assert.equal(classifyVerifier('test -f package.json && test -d dist').ok, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectRequestTarget } = require('../lib/secret-gateway');

test('rejects a fragment marker in the query without requiring both spellings', () => {
  for (const target of ['/allowed?value=#fragment', '/allowed?value=%23fragment']) {
    assert.deepStrictEqual(inspectRequestTarget(target), {
      ok: false,
      reason: 'fragment',
    });
  }
});

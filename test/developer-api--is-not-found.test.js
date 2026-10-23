'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isNotFound } = require('../lib/developer-api');

test('isNotFound recognizes numeric and numeric-string 404 statuses', () => {
  assert.strictEqual(isNotFound({ status: 404 }), true);
  assert.strictEqual(isNotFound({ status: '404' }), true);
  assert.strictEqual(isNotFound({ status: ' 404 ' }), true);
});

test('isNotFound rejects successful, other error, and malformed statuses', () => {
  for (const status of [200, 403, 500, 404.5, '404 not found', '', null, undefined, NaN]) {
    assert.strictEqual(isNotFound({ status }), false);
  }
  assert.strictEqual(isNotFound({ statusCode: 404 }), false);
});

test('isNotFound returns false for missing and empty results', () => {
  assert.strictEqual(isNotFound(), false);
  assert.strictEqual(isNotFound(null), false);
  assert.strictEqual(isNotFound({}), false);
  assert.strictEqual(isNotFound(false), false);
  assert.strictEqual(isNotFound(''), false);
});

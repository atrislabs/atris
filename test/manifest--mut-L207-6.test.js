'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { threeWayCompare } = require('../lib/manifest');

test('a synced file removed remotely is a remote deletion rather than a new local file', () => {
  const file = '/notes.md';
  const files = { [file]: { hash: 'abc', size: 3 } };
  const result = threeWayCompare(files, {}, { files });

  assert.strictEqual(result.deletedRemote.includes(file), true);
  assert.strictEqual(result.newLocal.includes(file), false);
});

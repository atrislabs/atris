'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { threeWayCompare } = require('../lib/manifest');

test('a remote edit is pulled when the local copy still matches the last sync', () => {
  const entry = (content) => ({
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  });
  const original = entry('draft\n');
  const updated = entry('revised draft\n');
  const file = '/notes.md';
  const result = threeWayCompare(
    { [file]: original },
    { [file]: updated },
    { last_sync: '2026-01-01T12:00:00.000Z', files: { [file]: original } }
  );

  assert.strictEqual(result.toPull.includes(file), true);
});

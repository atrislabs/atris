'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { threeWayCompare } = require('../lib/manifest');

test('independent edits to a previously synced file conflict', () => {
  const entry = content => ({
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  });
  const result = threeWayCompare(
    { '/notes.md': entry('local edits\n') },
    { '/notes.md': entry('remote edits\n') },
    { files: { '/notes.md': entry('original contents\n') } }
  );

  assert.strictEqual(result.conflicts.includes('/notes.md'), true);
});

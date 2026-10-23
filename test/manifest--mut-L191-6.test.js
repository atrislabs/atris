'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { threeWayCompare } = require('../lib/manifest');

function files(content) {
  return {
    '/notes.md': {
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    },
  };
}

test('different edits on both sides require conflict resolution instead of pulling', () => {
  const saved = { files: files('original notes\n') };
  const local = files('my revised notes\n');
  const remote = files('a teammate revised these notes\n');

  const result = threeWayCompare(local, remote, saved);

  assert.strictEqual(result.conflicts.includes('/notes.md'), true);
  assert.strictEqual(result.toPull.includes('/notes.md'), false);
});

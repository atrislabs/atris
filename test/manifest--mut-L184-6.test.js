'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildManifest, threeWayCompare } = require('../lib/manifest');

test('a newly created local file is offered for upload after an empty sync', () => {
  const content = 'Meeting notes\n';
  const local = {
    '/notes.md': {
      hash: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    },
  };
  const base = buildManifest({}, null);

  const result = threeWayCompare(local, {}, base);

  assert.equal(result.newLocal.includes('/notes.md'), true);
});

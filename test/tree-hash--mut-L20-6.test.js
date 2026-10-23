'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeTreeHash } = require('../lib/tree-hash');

test('directory traversal reports a symbolic link loop instead of hashing an empty tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-directory-loop-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.symlinkSync('skills', path.join(root, 'atris', 'skills'));
    assert.throws(() => computeTreeHash(root), { code: 'ELOOP' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

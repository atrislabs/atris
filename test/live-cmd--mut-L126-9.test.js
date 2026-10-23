'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shouldIgnore, collectSnapshot } = require('../commands/live');

test('shouldIgnore returns false for unignored file paths', () => {
  assert.equal(shouldIgnore('file.txt'), false);
  assert.equal(shouldIgnore('src/index.js'), false);
});

test('collectSnapshot captures unignored files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-mut-'));
  try {
    fs.writeFileSync(path.join(root, 'file.txt'), 'content');
    const snapshot = collectSnapshot(root);
    assert.equal(snapshot.has('file.txt'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

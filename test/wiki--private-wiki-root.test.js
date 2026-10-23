'use strict';

// PRIVATE_WIKI_ROOT is a path constant, not a function. It is the private wiki folder
// that getWikiRoot('private') and findLocalWikiDir(..., 'private') resolve against.
// Every write stays inside a fresh os.tmpdir() root, so the test never touches the repo or HOME.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PRIVATE_WIKI_ROOT, WIKI_ROOT, getWikiRoot, findLocalWikiDir } = require('../lib/wiki');

const roots = [];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-private-wiki-root-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('PRIVATE_WIKI_ROOT is the relative .atris/presidio folder, separate from the public wiki', () => {
  assert.strictEqual(PRIVATE_WIKI_ROOT, '.atris/presidio');
  assert.strictEqual(path.isAbsolute(PRIVATE_WIKI_ROOT), false);
  assert.notStrictEqual(PRIVATE_WIKI_ROOT, WIKI_ROOT);
  assert.strictEqual(getWikiRoot('private'), PRIVATE_WIKI_ROOT);
});

test('getWikiRoot falls back to the public wiki for the default and any non-private mode', () => {
  assert.strictEqual(getWikiRoot(), WIKI_ROOT);
  assert.strictEqual(getWikiRoot('public'), WIKI_ROOT);
  assert.strictEqual(getWikiRoot('anything-else'), WIKI_ROOT);
  assert.notStrictEqual(getWikiRoot(), PRIVATE_WIKI_ROOT);
});

test('findLocalWikiDir returns null in private mode when the private folder is missing', () => {
  const root = freshRoot();
  assert.strictEqual(findLocalWikiDir(root, null, 'private'), null);
});

test('findLocalWikiDir ignores the public wiki and finds only the private folder in private mode', () => {
  const root = freshRoot();
  fs.mkdirSync(path.join(root, WIKI_ROOT), { recursive: true });
  assert.strictEqual(findLocalWikiDir(root, null, 'private'), null);

  fs.mkdirSync(path.join(root, PRIVATE_WIKI_ROOT), { recursive: true });
  assert.strictEqual(
    findLocalWikiDir(root, null, 'private'),
    path.join(root, PRIVATE_WIKI_ROOT),
  );
});

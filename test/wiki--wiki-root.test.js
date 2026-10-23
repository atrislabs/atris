const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { WIKI_ROOT, PRIVATE_WIKI_ROOT, getWikiRoot } = require('../lib/wiki');

// WIKI_ROOT is a string constant, not a function, so these tests read its value
// and check how it combines with a project folder. Nothing is written to disk.

test('WIKI_ROOT is the relative public wiki folder with forward slashes', () => {
  assert.strictEqual(WIKI_ROOT, 'atris/wiki');
  assert.strictEqual(path.isAbsolute(WIKI_ROOT), false);
  assert.strictEqual(WIKI_ROOT.includes('\\'), false);
  assert.strictEqual(WIKI_ROOT.endsWith('/'), false);
});

test('WIKI_ROOT is the default wiki root and differs from the private root', () => {
  assert.strictEqual(getWikiRoot(), WIKI_ROOT);
  assert.strictEqual(getWikiRoot('public'), WIKI_ROOT);
  assert.strictEqual(getWikiRoot('private'), PRIVATE_WIKI_ROOT);
  assert.notStrictEqual(WIKI_ROOT, PRIVATE_WIKI_ROOT);
});

test('WIKI_ROOT joined onto a project folder stays inside that folder', () => {
  const projectRoot = path.join(os.tmpdir(), 'wiki-root-check');
  const wikiDir = path.resolve(projectRoot, WIKI_ROOT);
  const relative = path.relative(projectRoot, wikiDir).split(path.sep).join('/');

  assert.strictEqual(relative, 'atris/wiki');
  assert.strictEqual(relative.startsWith('..'), false);
});

test('WIKI_ROOT is a string, so calling it as a function throws', () => {
  assert.strictEqual(typeof WIKI_ROOT, 'string');
  assert.throws(() => WIKI_ROOT(), TypeError);
});

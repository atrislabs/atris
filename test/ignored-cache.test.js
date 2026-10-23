'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CACHE_DIR, cacheEnabled, cachePath, readCacheJson, writeCacheJson } = require('../lib/ignored-cache');

function tempRoot({ atris = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cache-'));
  if (atris) fs.mkdirSync(path.join(root, '.atris'));
  return root;
}

test('cache is only enabled when .atris is a directory', () => {
  assert.equal(cacheEnabled(tempRoot()), true);
  assert.equal(cacheEnabled(tempRoot({ atris: false })), false);
  const fileRoot = tempRoot({ atris: false });
  fs.writeFileSync(path.join(fileRoot, '.atris'), 'not a dir');
  assert.equal(cacheEnabled(fileRoot), false);
});

test('cachePath lives under .atris/cache', () => {
  assert.equal(cachePath('/r', 'x.json'), path.join('/r', CACHE_DIR, 'x.json'));
});

test('write then read round-trips and leaves a catch-all .gitignore', () => {
  const root = tempRoot();
  assert.equal(writeCacheJson(root, 'a.json', { n: 1, list: [1, 2] }), true);
  assert.deepEqual(readCacheJson(root, 'a.json'), { n: 1, list: [1, 2] });
  assert.equal(fs.readFileSync(path.join(root, CACHE_DIR, '.gitignore'), 'utf8'), '*\n');
  const leftovers = fs.readdirSync(path.join(root, CACHE_DIR)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('an existing cache .gitignore is not overwritten', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, CACHE_DIR, '.gitignore'), 'custom\n');
  writeCacheJson(root, 'b.json', 1);
  assert.equal(fs.readFileSync(path.join(root, CACHE_DIR, '.gitignore'), 'utf8'), 'custom\n');
});

test('missing or corrupt cache reads as null', () => {
  const root = tempRoot();
  assert.equal(readCacheJson(root, 'none.json'), null);
  fs.mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, CACHE_DIR, 'bad.json'), '{oops');
  assert.equal(readCacheJson(root, 'bad.json'), null);
});

test('a failed write returns false instead of throwing', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, CACHE_DIR), 'cache is a file');
  assert.equal(writeCacheJson(root, 'c.json', {}), false);
});

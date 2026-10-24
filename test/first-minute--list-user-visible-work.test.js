'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listUserVisibleWork } = require('../lib/first-minute');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-first-minute-'));
}

test('listUserVisibleWork returns visible files and non-empty dirs sorted', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'zeta.txt'), 'z');
  fs.writeFileSync(path.join(root, 'alpha.md'), 'a');
  fs.mkdirSync(path.join(root, 'middle-dir'));
  fs.writeFileSync(path.join(root, 'middle-dir', 'inner.js'), 'x');

  const result = listUserVisibleWork(root);

  assert.deepStrictEqual(result, ['alpha.md', 'middle-dir', 'zeta.txt']);
});

test('listUserVisibleWork hides dotfiles, task db files, and empty dirs', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, '.hidden'), 'h');
  fs.writeFileSync(path.join(root, '.atris-later'), 'l');
  fs.writeFileSync(path.join(root, 'tasks.db'), 'd');
  fs.writeFileSync(path.join(root, 'tasks.db-wal'), 'w');
  fs.writeFileSync(path.join(root, 'tasks.db-shm'), 's');
  fs.mkdirSync(path.join(root, '.config'));
  fs.writeFileSync(path.join(root, '.config', 'x'), 'x');
  fs.mkdirSync(path.join(root, 'empty-dir'));
  fs.mkdirSync(path.join(root, 'only-hidden'));
  fs.writeFileSync(path.join(root, 'only-hidden', '.secret'), 's');
  fs.writeFileSync(path.join(root, 'real.txt'), 'r');

  const result = listUserVisibleWork(root);

  assert.deepStrictEqual(result, ['real.txt']);
});

test('listUserVisibleWork returns empty array for missing or empty roots', () => {
  const missing = path.join(makeRoot(), 'does-not-exist');
  assert.deepStrictEqual(listUserVisibleWork(missing), []);

  const empty = makeRoot();
  assert.deepStrictEqual(listUserVisibleWork(empty), []);
});

const test = require('node:test');
const assert = require('node:assert');
const { isIgnoredSyncPath } = require('../lib/manifest');

test('ignores excluded path components while keeping ordinary files', () => {
  for (const filePath of ['src/index.js', '/docs/readme.md', 'src/building.js', 'node_modules-extra/index.js']) {
    assert.strictEqual(isIgnoredSyncPath(filePath), false, filePath);
  }
  for (const filePath of ['node_modules/pkg/index.js', '/src/dist/main.js', 'coverage', 'Library/preferences.txt', 'src/.git/config']) {
    assert.strictEqual(isIgnoredSyncPath(filePath), true, filePath);
  }
});

test('normalizes separators and distinguishes hidden directories from dotfiles', () => {
  assert.strictEqual(isIgnoredSyncPath('src\\node_modules\\pkg\\index.js'), true);
  assert.strictEqual(isIgnoredSyncPath('\\.github\\workflows\\ci.yml'), false);
  assert.strictEqual(isIgnoredSyncPath('//src///.private//file.txt'), true);
  assert.strictEqual(isIgnoredSyncPath('.github/workflows/ci.yml'), false);
  assert.strictEqual(isIgnoredSyncPath('.github/.private/file.txt'), true);
  assert.strictEqual(isIgnoredSyncPath('.github-extra/workflows/ci.yml'), true);
  assert.strictEqual(isIgnoredSyncPath('src/.env'), false);
  assert.strictEqual(isIgnoredSyncPath('.private'), false);
  assert.strictEqual(isIgnoredSyncPath('.private/file.txt'), true);
});

test('empty and missing paths contain no ignored components', () => {
  assert.strictEqual(isIgnoredSyncPath(), false);
  for (const filePath of ['', null, undefined, '/', '\\', '///']) {
    assert.strictEqual(isIgnoredSyncPath(filePath), false);
  }
});

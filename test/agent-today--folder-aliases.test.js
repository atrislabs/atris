const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderAliases } = require('../lib/agent-today');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-aliases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

test('an ordinary folder appears once, including when PWD repeats it', (t) => {
  const root = fixture(t);
  assert.deepStrictEqual(folderAliases(root), [root]);
  assert.deepStrictEqual(folderAliases(root, { PWD: root }), [root]);
});

test('symbolic links follow the real folder in cwd then PWD order', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(target);
  fs.symlinkSync(target, first, 'dir');
  fs.symlinkSync(target, second, 'dir');

  assert.deepStrictEqual(folderAliases(first, { PWD: second }), [target, first, second]);
  assert.deepStrictEqual(folderAliases(first, { PWD: first }), [target, first]);
  assert.deepStrictEqual(folderAliases(target, { PWD: second }), [target, second]);
});

test('unrelated, missing, relative, and empty PWD values add no aliases', (t) => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  const other = path.join(root, 'other');
  fs.mkdirSync(target);
  fs.mkdirSync(other);

  for (const pwd of [other, path.join(root, 'missing'), 'target', '']) {
    assert.deepStrictEqual(folderAliases(target, { PWD: pwd }), [target]);
  }
});

test('a missing cwd is preserved when resolution fails', (t) => {
  const root = fixture(t);
  const missing = path.join(root, 'missing');
  assert.deepStrictEqual(folderAliases(missing, { PWD: root }), [missing]);
  assert.deepStrictEqual(folderAliases(missing, { PWD: missing }), [missing]);
});

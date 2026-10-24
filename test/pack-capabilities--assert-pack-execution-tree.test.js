'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate environment
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-home-'));
process.env.HOME = isolatedHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

process.on('exit', () => {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch (_) {}
});

const { assertPackExecutionTree } = require('../lib/pack-capabilities');

function makeTempDir(prefix = 'atris-pack-tree-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

test('assertPackExecutionTree accepts valid directory structure and returns realpath', (t) => {
  const root = makeTempDir();
  t.after(() => removeDir(root));

  fs.writeFileSync(path.join(root, 'pack.json'), '{"name":"sample"}');
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');

  const nestedDir = path.join(root, 'nested', 'deep');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, 'data.txt'), 'payload');

  const result = assertPackExecutionTree(root);
  assert.strictEqual(result, fs.realpathSync(root));
});

test('assertPackExecutionTree accepts empty directory', (t) => {
  const root = makeTempDir();
  t.after(() => removeDir(root));

  const result = assertPackExecutionTree(root);
  assert.strictEqual(result, fs.realpathSync(root));
});

test('assertPackExecutionTree accepts symlink to root directory itself', (t) => {
  const targetDir = makeTempDir('atris-pack-target-');
  const linkDirParent = makeTempDir('atris-pack-link-parent-');
  t.after(() => {
    removeDir(targetDir);
    removeDir(linkDirParent);
  });

  fs.writeFileSync(path.join(targetDir, 'pack.json'), '{}');
  const symlinkRoot = path.join(linkDirParent, 'link-root');
  try {
    fs.symlinkSync(targetDir, symlinkRoot, 'dir');
  } catch (err) {
    if (err.code === 'EPERM') return;
    throw err;
  }

  const result = assertPackExecutionTree(symlinkRoot);
  assert.strictEqual(result, fs.realpathSync(targetDir));
});

test('assertPackExecutionTree throws when execution tree contains a symlink', (t) => {
  const root = makeTempDir();
  t.after(() => removeDir(root));

  const targetFile = path.join(root, 'target.txt');
  fs.writeFileSync(targetFile, 'data');

  const linkFile = path.join(root, 'link.txt');
  try {
    fs.symlinkSync('target.txt', linkFile, 'file');
  } catch (err) {
    if (err.code === 'EPERM') return;
    throw err;
  }

  assert.throws(
    () => assertPackExecutionTree(root),
    (err) => {
      assert.strictEqual(err.message, 'declared pack execution tree cannot contain symlinks: link.txt');
      return true;
    },
  );
});

test('assertPackExecutionTree throws when execution tree contains nested symlink', (t) => {
  const root = makeTempDir();
  t.after(() => removeDir(root));

  const subDir = path.join(root, 'sub', 'folder');
  fs.mkdirSync(subDir, { recursive: true });

  const targetFile = path.join(root, 'sub', 'original.txt');
  fs.writeFileSync(targetFile, 'content');

  const linkFile = path.join(subDir, 'nested-link.txt');
  try {
    fs.symlinkSync('../original.txt', linkFile, 'file');
  } catch (err) {
    if (err.code === 'EPERM') return;
    throw err;
  }

  assert.throws(
    () => assertPackExecutionTree(root),
    (err) => {
      assert.strictEqual(
        err.message,
        'declared pack execution tree cannot contain symlinks: sub/folder/nested-link.txt',
      );
      return true;
    },
  );
});

test('assertPackExecutionTree throws when root directory does not exist', () => {
  const missingPath = path.join(isolatedHome, 'nonexistent-directory');
  assert.throws(
    () => assertPackExecutionTree(missingPath),
    { code: 'ENOENT' },
  );
});

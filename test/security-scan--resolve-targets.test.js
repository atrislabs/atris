'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTargets } = require('../lib/security-scan');

for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-home-'));
process.env.HOME = sandboxHome;

test.after(() => {
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  } catch {}
});

test('resolveTargets with explicit paths resolves scannable files and ignores skipped directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-targets-paths-'));
  try {
    fs.writeFileSync(path.join(dir, 'main.js'), 'console.log("hello");\n');
    fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'nested', 'util.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'ignored.bin'), Buffer.from([0, 1, 2, 3]));

    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'package.json'), '{}');

    fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixtures', 'mock.json'), '{}');

    const result = resolveTargets({
      root: dir,
      paths: ['main.js', 'src', 'node_modules', 'fixtures'],
    });

    const expectedRelPaths = ['main.js', path.join('src', 'nested', 'util.ts')];
    assert.deepStrictEqual(result.relPaths.sort(), expectedRelPaths.sort());

    const expectedFiles = expectedRelPaths.map((rel) => path.join(dir, rel));
    assert.deepStrictEqual(result.files.sort(), expectedFiles.sort());
    assert.ok(result.files.every((f) => path.isAbsolute(f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTargets falls back to filesystem walk in non-git directory and filters appropriately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-targets-walk-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'FOO=bar\n');
    fs.writeFileSync(path.join(dir, 'doc.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'archive.tar.gz'), 'binary');

    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'bundle');

    fs.mkdirSync(path.join(dir, '__snapshots__'));
    fs.writeFileSync(path.join(dir, '__snapshots__', 'snap.js'), 'snap');

    const result = resolveTargets({ root: dir });

    const expectedRelPaths = ['.env.local', 'app.py', 'doc.txt'];
    assert.deepStrictEqual(result.relPaths.sort(), expectedRelPaths.sort());

    const expectedFiles = expectedRelPaths.map((rel) => path.join(dir, rel));
    assert.deepStrictEqual(result.files.sort(), expectedFiles.sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTargets handles empty directories and nonexistent target paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-targets-empty-'));
  try {
    const emptyResult = resolveTargets({ root: dir });
    assert.deepStrictEqual(emptyResult, { files: [], relPaths: [] });

    const missingResult = resolveTargets({
      root: dir,
      paths: ['does-not-exist.js', 'missing-folder'],
    });
    assert.deepStrictEqual(missingResult, { files: [], relPaths: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

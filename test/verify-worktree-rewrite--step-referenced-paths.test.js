'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stepReferencedPaths } = require('../lib/verify-worktree-rewrite');

test('node --check reports the step folder and the checked file', () => {
  const paths = stepReferencedPaths({ argv: ['node', '--check', 'scripts/t.mjs'], cwd: 'packages/app' });
  assert.deepStrictEqual(paths, [
    { path: 'packages/app', kind: 'dir' },
    { path: 'scripts/t.mjs', kind: 'file' },
  ]);
});

test('node --test keeps real test files and skips flags and globs', () => {
  const paths = stepReferencedPaths({
    argv: ['node', '--test', '--test-reporter=spec', 'test/a.test.js', 'test/*.test.js', 'lib/b.mjs'],
  });
  assert.deepStrictEqual(paths, [
    { path: 'test/a.test.js', kind: 'file' },
    { path: 'lib/b.mjs', kind: 'file' },
  ]);
});

test('python runs the script file but not python -m modules', () => {
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['python3', 'tools/check.py'] }), [
    { path: 'tools/check.py', kind: 'file' },
  ]);
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['python3', '-m', 'pytest'] }), []);
});

test('test -f and test -s report the file they check', () => {
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['test', '-f', 'dist/out.js'] }), [
    { path: 'dist/out.js', kind: 'file' },
  ]);
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['test', '-s', 'out/report.txt'] }), [
    { path: 'out/report.txt', kind: 'file' },
  ]);
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['test', '-d', 'dist'] }), []);
});

test('empty or malformed steps reference nothing', () => {
  assert.deepStrictEqual(stepReferencedPaths(undefined), []);
  assert.deepStrictEqual(stepReferencedPaths(null), []);
  assert.deepStrictEqual(stepReferencedPaths({}), []);
  assert.deepStrictEqual(stepReferencedPaths({ argv: 'node --check x.js' }), []);
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['node', '--check', 'plainword'] }), []);
});

test('an empty cwd adds no folder entry', () => {
  assert.deepStrictEqual(stepReferencedPaths({ argv: ['node', '--check', 'a.js'], cwd: '' }), [
    { path: 'a.js', kind: 'file' },
  ]);
});

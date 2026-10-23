'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseScopeFlag, pathUnderRoot } = require('../lib/cli-scope');

test('parseScopeFlag defaults to workspace scope and keeps args', () => {
  assert.deepEqual(parseScopeFlag(['--json', 'x']), {
    kind: 'workspace',
    global: false,
    args: ['--json', 'x'],
  });
});

test('parseScopeFlag accepts --global and -g and strips them from args', () => {
  assert.deepEqual(parseScopeFlag(['--global', 'a']), { kind: 'global', global: true, args: ['a'] });
  assert.deepEqual(parseScopeFlag(['a', '-g', '-g']), { kind: 'global', global: true, args: ['a'] });
});

test('parseScopeFlag tolerates missing or non-array input', () => {
  assert.deepEqual(parseScopeFlag(), { kind: 'workspace', global: false, args: [] });
  assert.deepEqual(parseScopeFlag('--global'), { kind: 'workspace', global: false, args: [] });
});

test('pathUnderRoot matches the root itself and nested paths', () => {
  const root = path.resolve('/tmp/atris-root');
  assert.equal(pathUnderRoot(root, root), true);
  assert.equal(pathUnderRoot(path.join(root, 'a', 'b'), root), true);
  assert.equal(pathUnderRoot(`${root}/`, root), true);
});

test('pathUnderRoot rejects siblings that only share a name prefix', () => {
  const root = path.resolve('/tmp/atris-root');
  assert.equal(pathUnderRoot(`${root}-other`, root), false);
  assert.equal(pathUnderRoot(path.resolve('/tmp'), root), false);
});

test('pathUnderRoot treats every path as under the filesystem root', () => {
  const fsRoot = path.parse(process.cwd()).root;
  assert.equal(pathUnderRoot(path.join(fsRoot, 'etc'), fsRoot), true);
  assert.equal(pathUnderRoot(fsRoot, fsRoot), true);
});

test('pathUnderRoot is false when either side is empty', () => {
  assert.equal(pathUnderRoot('', '/tmp'), false);
  assert.equal(pathUnderRoot('/tmp', null), false);
});

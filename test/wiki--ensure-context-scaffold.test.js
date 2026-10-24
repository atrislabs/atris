'use strict';

// ensureContextScaffold creates the raw-source folder that `atris ingest` stages into.
// Every path here is inside a fresh os.tmpdir() root, so the test never touches the repo or HOME.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureContextScaffold } = require('../lib/wiki');

const roots = [];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-context-scaffold-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('public mode creates atris/context with an _ingest folder and a README', () => {
  const root = freshRoot();
  const contextDir = ensureContextScaffold(root, 'public');

  assert.equal(contextDir, path.join(root, 'atris', 'context'));
  assert.ok(fs.statSync(path.join(contextDir, '_ingest')).isDirectory());

  const readme = fs.readFileSync(path.join(contextDir, 'README.md'), 'utf8');
  assert.match(readme, /^# Context$/m);
  assert.ok(readme.includes('`atris/context/`'), 'README names the public context folder');
  assert.ok(readme.includes('`atris/wiki/`'), 'README names the public wiki folder');
  assert.ok(readme.includes('`atris/context/_ingest/`'), 'README names the ingest folder');
});

test('default mode is public when no mode is passed', () => {
  const root = freshRoot();
  const contextDir = ensureContextScaffold(root);

  assert.equal(contextDir, path.join(root, 'atris', 'context'));
  assert.ok(fs.existsSync(path.join(contextDir, 'README.md')));
});

test('private mode writes under .atris/presidio and leaves the public folder alone', () => {
  const root = freshRoot();
  const contextDir = ensureContextScaffold(root, 'private');

  assert.equal(contextDir, path.join(root, '.atris', 'presidio', 'context'));
  assert.ok(fs.statSync(path.join(contextDir, '_ingest')).isDirectory());

  const readme = fs.readFileSync(path.join(contextDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('`.atris/presidio/context/`'), 'README names the private context folder');
  assert.ok(readme.includes('`.atris/presidio/`'), 'README names the private wiki root');

  assert.equal(fs.existsSync(path.join(root, 'atris')), false, 'public folder is not created');
});

test('a second call keeps an existing README and does not overwrite it', () => {
  const root = freshRoot();
  const contextDir = ensureContextScaffold(root, 'public');
  const readmePath = path.join(contextDir, 'README.md');

  fs.writeFileSync(readmePath, 'my own notes\n', 'utf8');
  const again = ensureContextScaffold(root, 'public');

  assert.equal(again, contextDir);
  assert.equal(fs.readFileSync(readmePath, 'utf8'), 'my own notes\n');
});

test('a file where the context folder should go makes the call throw', () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'atris'), 'not a folder', 'utf8');

  assert.throws(
    () => ensureContextScaffold(root, 'public'),
    (err) => ['ENOTDIR', 'EEXIST'].includes(err.code),
  );
  assert.equal(fs.readFileSync(path.join(root, 'atris'), 'utf8'), 'not a folder');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mapNotesPath, MAP_REF_DOCS } = require('../lib/map-refs');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'map-notes-path-'));
}

function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

test('returns the repo-relative notes path when the notes file exists', () => {
  const root = makeRoot();
  try {
    write(root, 'atris/refs/MAP-NOTES.md', '# notes\n');
    const result = mapNotesPath(root);
    assert.strictEqual(result, 'atris/refs/MAP-NOTES.md');
    assert.strictEqual(result, MAP_REF_DOCS[1]);
    assert.ok(!path.isAbsolute(result));
    assert.ok(fs.statSync(path.join(root, result)).isFile());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns the notes path even when the boot map is also present', () => {
  const root = makeRoot();
  try {
    write(root, 'atris/MAP.md', '# map\n');
    write(root, 'atris/refs/MAP-NOTES.md', '# notes\n');
    assert.strictEqual(mapNotesPath(root), 'atris/refs/MAP-NOTES.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when only the boot map exists', () => {
  const root = makeRoot();
  try {
    write(root, 'atris/MAP.md', '# map\n');
    assert.strictEqual(mapNotesPath(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns null for an empty workspace', () => {
  const root = makeRoot();
  try {
    assert.strictEqual(mapNotesPath(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when the root directory does not exist', () => {
  const root = makeRoot();
  fs.rmSync(root, { recursive: true, force: true });
  assert.strictEqual(mapNotesPath(root), null);
  assert.strictEqual(mapNotesPath(path.join(root, 'nested', 'missing')), null);
});

test('returns null when the notes path is a directory, not a file', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'atris', 'refs', 'MAP-NOTES.md'), { recursive: true });
    assert.strictEqual(mapNotesPath(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when a parent of the notes path is a file (ENOTDIR)', () => {
  const root = makeRoot();
  try {
    write(root, 'atris/refs', 'not a directory\n');
    assert.strictEqual(mapNotesPath(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty notes file still counts as present', () => {
  const root = makeRoot();
  try {
    write(root, 'atris/refs/MAP-NOTES.md', '');
    assert.strictEqual(mapNotesPath(root), 'atris/refs/MAP-NOTES.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolves a relative root against the current directory', () => {
  const root = makeRoot();
  const original = process.cwd();
  try {
    write(root, 'atris/refs/MAP-NOTES.md', '# notes\n');
    process.chdir(root);
    assert.strictEqual(mapNotesPath('.'), 'atris/refs/MAP-NOTES.md');
    assert.strictEqual(mapNotesPath('nope'), null);
  } finally {
    process.chdir(original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

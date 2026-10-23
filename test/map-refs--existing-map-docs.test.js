'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { existingMapDocs } = require('../lib/map-refs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-existing-map-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('returns both existing map documents in canonical order, ignoring other files', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'atris', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'refs', 'MAP-NOTES.md'), 'notes');
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), 'map');
  fs.writeFileSync(path.join(root, 'atris', 'OTHER.md'), 'other');

  assert.deepStrictEqual(existingMapDocs(root), ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']);
});

test('returns only regular files and notices documents added or removed between calls', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'atris', 'MAP.md'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris', 'refs'));
  const notes = path.join(root, 'atris', 'refs', 'MAP-NOTES.md');
  fs.writeFileSync(notes, '');

  assert.deepStrictEqual(existingMapDocs(root), ['atris/refs/MAP-NOTES.md']);
  fs.rmdirSync(path.join(root, 'atris', 'MAP.md'));
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '');
  fs.unlinkSync(notes);
  assert.deepStrictEqual(existingMapDocs(root), ['atris/MAP.md']);
});

test('returns an empty array for missing documents and missing roots', t => {
  const root = fixture(t);

  assert.deepStrictEqual(existingMapDocs(root), []);
  assert.deepStrictEqual(existingMapDocs(path.join(root, 'missing')), []);
});

test('returns an empty array when a parent component is a file', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'atris'), 'not a directory');

  assert.deepStrictEqual(existingMapDocs(root), []);
});

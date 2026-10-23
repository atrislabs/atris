'use strict';

// fixMapDocs rewrites stale file:line refs in atris/MAP.md and
// atris/refs/MAP-NOTES.md when the named symbol sits unambiguously on another
// line, and reports what it moved plus the refs a human still has to fix.
// These tests build throwaway roots in the temp dir so the real map docs and
// the machine's environment are never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fixMapDocs } = require('../lib/map-refs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fix-map-docs-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  return root;
}

function writeMap(root, text) {
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), text);
}

function writeNotes(root, text) {
  fs.mkdirSync(path.join(root, 'atris', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'refs', 'MAP-NOTES.md'), text);
}

test('a moved ref in MAP.md is rewritten on disk and reported', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(root, 'lib', 'a.js'),
    '// a\n//\n//\n//\n//\n//\n//\nfunction alpha() {}\n'
  );
  writeMap(root, '# map\n\n- `lib/a.js:1` `alpha` does the thing\n');

  const result = fixMapDocs(root);

  assert.equal(result.changes.length, 1);
  const change = result.changes[0];
  assert.equal(change.doc, 'atris/MAP.md');
  assert.equal(change.map_line, 3);
  assert.equal(change.from, 'lib/a.js:1');
  assert.equal(change.to, 'lib/a.js:8');
  assert.equal(change.symbol, 'alpha');
  assert.deepEqual(result.left, []);

  const written = fs.readFileSync(path.join(root, 'atris', 'MAP.md'), 'utf8');
  assert.ok(written.includes('`lib/a.js:8` `alpha`'), 'the map file itself is updated');
  assert.ok(!written.includes('lib/a.js:1'), 'the stale line number is gone');
});

test('refs in both MAP.md and MAP-NOTES.md are fixed in one run', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(root, 'lib', 'a.js'),
    '// a\n//\n//\n//\n//\n//\n//\nfunction alpha() {}\n'
  );
  fs.writeFileSync(
    path.join(root, 'lib', 'b.js'),
    '// b\n//\n//\n//\n//\n//\n//\nfunction beta() {}\n'
  );
  writeMap(root, '# map\n\n- `lib/a.js:1` `alpha` does the thing\n');
  writeNotes(root, '# notes\n\n- `lib/b.js:1` `beta` does the other thing\n');

  const result = fixMapDocs(root);

  assert.equal(result.changes.length, 2);
  const docs = result.changes.map((change) => change.doc).sort();
  assert.deepEqual(docs, ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']);

  const notes = fs.readFileSync(path.join(root, 'atris', 'refs', 'MAP-NOTES.md'), 'utf8');
  assert.ok(notes.includes('`lib/b.js:8` `beta`'));
});

test('refs that already point at the symbol leave the file untouched', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'lib', 'a.js'), '// a\nfunction alpha() {}\n');
  const mapText = '# map\n\n- `lib/a.js:2` `alpha` does the thing\n';
  writeMap(root, mapText);

  const result = fixMapDocs(root);

  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.left, []);
  assert.equal(fs.readFileSync(path.join(root, 'atris', 'MAP.md'), 'utf8'), mapText);
});

test('refs that cannot be fixed are left for a human, not rewritten', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(root, 'lib', 'a.js'),
    'function alpha() { return 1; }\n\n\n\n\nfunction alpha() { return 2; }\n'
  );
  const mapText = '# map\n\n- `lib/gone.js:5` `omega` is gone\n- `lib/a.js:9` `alpha` is twice\n';
  writeMap(root, mapText);

  const result = fixMapDocs(root);

  assert.deepEqual(result.changes, []);
  assert.equal(result.left.length, 2);
  const gone = result.left.find((ref) => ref.raw === 'lib/gone.js:5');
  const twice = result.left.find((ref) => ref.raw === 'lib/a.js:9');
  assert.equal(gone.doc, 'atris/MAP.md');
  assert.equal(gone.status, 'missing-file');
  assert.equal(twice.status, 'ambiguous');
  assert.deepEqual(twice.lines, [1, 6]);

  assert.equal(fs.readFileSync(path.join(root, 'atris', 'MAP.md'), 'utf8'), mapText);
});

test('a root with no map docs returns an empty result without throwing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fix-map-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = fixMapDocs(root);

  assert.deepEqual(result, { changes: [], left: [] });
});

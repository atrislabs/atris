'use strict';

// Boot scores the docs on every session start, and that score checks every
// file:line ref in the map files against the code. Reading all of that code
// each boot cost more than half a second on this repo, so the result is
// cached per map file and reused only while the map text and the size and
// modified time of every file it points at are unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkMapDocs } = require('../lib/map-refs');

const CACHE = path.join('.atris', 'state', 'map-refs-cache.json');

function makeRoot({ atris = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-refs-cache-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  if (atris) fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n\n- `lib/a.js:2` `alpha` does the thing\n');
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), '// a\nfunction alpha() {}\n');
  return root;
}

// Count reads of one file while fn runs; everything else reads normally.
function countReads(file, fn) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file)) reads += 1;
    return original.call(this, target, ...rest);
  };
  try {
    return { value: fn(), reads };
  } finally {
    fs.readFileSync = original;
  }
}

test('a second check reuses the cached result without reading the code again', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = path.join(root, 'lib', 'a.js');

  const first = countReads(code, () => checkMapDocs(root));
  assert.equal(first.reads, 1);
  assert.equal(first.value.refs[0].status, 'ok');
  assert.ok(fs.existsSync(path.join(root, CACHE)), 'the result is saved for the next boot');

  const second = countReads(code, () => checkMapDocs(root));
  assert.equal(second.reads, 0, 'an unchanged file is not read again');
  assert.deepEqual(second.value, first.value);
});

test('editing the code the map points at recomputes the result', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkMapDocs(root);
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), '// a\n\n\n\n\n\n\nfunction alpha() {}\n');
  const after = checkMapDocs(root);
  assert.equal(after.refs[0].status, 'moved');
  assert.equal(after.refs[0].line, 8);
});

test('deleting the code the map points at recomputes the result', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkMapDocs(root);
  fs.rmSync(path.join(root, 'lib', 'a.js'));
  assert.equal(checkMapDocs(root).refs[0].status, 'missing-file');
});

test('editing the map text recomputes the result', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkMapDocs(root);
  const moved = '# map\n\n- `lib/a.js:1` `alpha` does the thing\n';
  const after = checkMapDocs(root, moved);
  assert.equal(after.refs[0].status, 'ok', 'alpha is within the three-line window of line 1');
  assert.equal(after.refs[0].start, 1);
});

test('a corrupt cache file is ignored and rewritten', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, CACHE), '{not json');
  assert.equal(checkMapDocs(root).refs[0].status, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, CACHE), 'utf8')).version, 1);
});

test('a folder without .atris gets no cache file', (t) => {
  const root = makeRoot({ atris: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(checkMapDocs(root).refs[0].status, 'ok');
  assert.equal(fs.existsSync(path.join(root, '.atris')), false);
});

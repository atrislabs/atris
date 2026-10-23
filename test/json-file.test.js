'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeJson } = require('../lib/json-file');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atris-json-'));

test('writeJson creates parent dirs, pretty prints, and ends with a newline', () => {
  const file = path.join(tmp(), 'a', 'b', 'c.json');
  assert.equal(writeJson(file, { x: [1] }), file);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "x": [\n    1\n  ]\n}\n');
});

test('writeJson honors a custom indent', () => {
  const file = path.join(tmp(), 'c.json');
  writeJson(file, { x: 1 }, { indent: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}\n');
});

test('readJson round-trips what writeJson wrote', () => {
  const file = path.join(tmp(), 'r.json');
  writeJson(file, { ok: true, n: null });
  assert.deepEqual(readJson(file), { ok: true, n: null });
});

test('readJson returns the fallback for missing or corrupt files', () => {
  const dir = tmp();
  assert.equal(readJson(path.join(dir, 'missing.json')), null);
  assert.deepEqual(readJson(path.join(dir, 'missing.json'), {}), {});
  fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
  assert.deepEqual(readJson(path.join(dir, 'bad.json'), []), []);
});

test('readJson returns a stored falsy value rather than the fallback', () => {
  const file = path.join(tmp(), 'zero.json');
  writeJson(file, 0);
  assert.equal(readJson(file, 5), 0);
});

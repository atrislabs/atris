'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_BASELINE, loadBaseline, writeBaseline } = require('../lib/security-scan');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-baseline-'));
}

test('DEFAULT_BASELINE is a stable relative json filename', () => {
  assert.equal(typeof DEFAULT_BASELINE, 'string');
  assert.equal(DEFAULT_BASELINE, '.security-review.baseline.json');
  assert.equal(path.isAbsolute(DEFAULT_BASELINE), false);
  assert.equal(path.extname(DEFAULT_BASELINE), '.json');
});

test('loadBaseline defaults to DEFAULT_BASELINE and tolerates a missing file', () => {
  const root = tmpdir();
  const res = loadBaseline(root);
  assert.equal(res.file, path.join(root, DEFAULT_BASELINE));
  assert.deepEqual(res.fingerprints, []);
});

test('writeBaseline + loadBaseline round-trip through the default filename', () => {
  const root = tmpdir();
  const written = writeBaseline(root, [{ fingerprint: 'fp-b' }, { fingerprint: 'fp-a' }]);
  assert.equal(written.file, path.join(root, DEFAULT_BASELINE));
  assert.ok(fs.existsSync(path.join(root, DEFAULT_BASELINE)));
  assert.deepEqual(written.fingerprints, ['fp-a', 'fp-b']);

  const loaded = loadBaseline(root);
  assert.deepEqual(loaded.fingerprints, ['fp-a', 'fp-b']);
});

test('loadBaseline throws on malformed json at the default path', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, DEFAULT_BASELINE), 'not json{');
  assert.throws(() => loadBaseline(root), /invalid baseline json/);
});

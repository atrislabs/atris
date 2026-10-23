'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBaseline } = require('../lib/security-scan');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-load-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('loadBaseline loads the default object format and filters only nonstrings', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, '.security-review.baseline.json');
  fs.writeFileSync(file, JSON.stringify({
    fingerprints: ['first', 42, null, 'second', false, {}, [], '', 'first'],
  }));

  assert.deepStrictEqual(loadBaseline(root), {
    file,
    fingerprints: ['first', 'second', '', 'first'],
  });
});

test('loadBaseline accepts arrays at relative and absolute custom paths', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, 'custom.json');
  fs.writeFileSync(file, JSON.stringify(['alpha', null, 'beta']));
  const expected = { file, fingerprints: ['alpha', 'beta'] };

  assert.deepStrictEqual(loadBaseline(root, 'custom.json'), expected);
  assert.deepStrictEqual(loadBaseline(path.join(root, 'unused-root'), file), expected);
});

test('loadBaseline returns empty fingerprints for a missing file and empty arrays', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, '.security-review.baseline.json');

  assert.deepStrictEqual(loadBaseline(root), { file, fingerprints: [] });
  assert.strictEqual(fs.existsSync(file), false);
  for (const payload of [[], { fingerprints: [] }]) {
    fs.writeFileSync(file, JSON.stringify(payload));
    assert.deepStrictEqual(loadBaseline(root), { file, fingerprints: [] });
  }
});

test('loadBaseline rejects malformed JSON with the relative file name', (t) => {
  const root = temporaryRoot(t);
  fs.writeFileSync(path.join(root, 'broken.json'), '{');

  assert.throws(() => loadBaseline(root, 'broken.json'), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^invalid baseline json: broken\.json \(/);
    return true;
  });
});

test('loadBaseline rejects parsed JSON without a fingerprints array', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, '.security-review.baseline.json');

  for (const payload of [null, {}, { fingerprints: 'alpha' }, { fingerprints: null }, 7, 'alpha']) {
    fs.writeFileSync(file, JSON.stringify(payload));
    assert.throws(() => loadBaseline(root), {
      message: 'invalid baseline json: expected {"fingerprints":[...]}',
    });
  }
});

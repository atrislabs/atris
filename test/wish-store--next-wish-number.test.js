'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextWishNumber } = require('../lib/wish-store');

function fixture(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-number-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (contents !== undefined) {
    const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
  }
  return root;
}

test('nextWishNumber returns one above the highest assigned number, regardless of order or gaps', (t) => {
  const root = fixture(t, [
    { id: 'wish-a', n: 2 },
    { id: 'wish-b', n: 9 },
    { id: 'wish-c', n: 4 },
  ].map(JSON.stringify).join('\n'));

  assert.strictEqual(nextWishNumber(root), 10);
});

test('nextWishNumber ignores later numbers for the same wish and invalid numbers', (t) => {
  const root = fixture(t, [
    { id: 'wish-a', n: 3 },
    { id: 'wish-a', n: 100 },
    { id: 'wish-b', n: '7' },
    { id: 'wish-zero', n: 0 },
    { id: 'wish-negative', n: -20 },
    { id: 'wish-fraction', n: 99.5 },
    { id: 'wish-invalid', n: 'unknown' },
    { id: 'wish-legacy' },
  ].map(JSON.stringify).join('\n'));

  assert.strictEqual(nextWishNumber(root), 8);
});

test('nextWishNumber starts at one for a missing or empty wish log', (t) => {
  assert.strictEqual(nextWishNumber(fixture(t)), 1);
  assert.strictEqual(nextWishNumber(fixture(t, '')), 1);
  assert.strictEqual(nextWishNumber(fixture(t, ' \n\r\n')), 1);
});

test('nextWishNumber skips malformed JSON lines while retaining valid records', (t) => {
  const root = fixture(t, 'not json\r\nnull\r\n{"id":"wish-a","n":5}\r\n{"n":\r\n');

  assert.strictEqual(nextWishNumber(root), 6);
  assert.strictEqual(nextWishNumber(fixture(t, 'not json\nnull\n')), 1);
});

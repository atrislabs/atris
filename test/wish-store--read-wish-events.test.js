'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWishEvents } = require('../lib/wish-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-events-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  return { root, write(content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } };
}

test('readWishEvents preserves event order and separate updates to the same wish', (t) => {
  const { root, write } = fixture(t);
  const events = [
    { id: 'wish-one', ts: '2024-01-02T00:00:00.000Z', text: 'Read a book' },
    { kind: 'review', wish_id: 'wish-one', review_score: 0, review_text: 'Still reading' },
    { id: 'wish-one', ts: '2024-01-01T00:00:00.000Z', answer: 'Chapter one', extra: { done: false } },
  ];
  write(events.map((event) => JSON.stringify(event)).join('\n'));

  assert.deepStrictEqual(readWishEvents(root), events);
});

test('readWishEvents skips malformed and blank lines while retaining valid neighbors', (t) => {
  const { root, write } = fixture(t);
  const first = { id: 'wish-one', text: 'Café ☕' };
  const last = { kind: 'steer', wish_id: 'wish-one', note: 'Keep going' };
  write(`  ${JSON.stringify(first)}  \r\n\r\n  \t\r\n{broken json}\r\nnull\r\nfalse\r\n0\r\n""\r\n${JSON.stringify(last)}\r\n`);

  assert.deepStrictEqual(readWishEvents(root), [first, last]);
});

test('readWishEvents returns an empty array for missing, empty, or unusable input', (t) => {
  const { root, write } = fixture(t);
  assert.deepStrictEqual(readWishEvents(root), []);

  write('');
  assert.deepStrictEqual(readWishEvents(root), []);

  write('\n \t\ninvalid\n{\nnull\n');
  assert.deepStrictEqual(readWishEvents(root), []);
});

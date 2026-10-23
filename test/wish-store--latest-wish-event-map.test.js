'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { latestWishEventMap } = require('../lib/wish-store');

function fixture(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-event-map-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (contents !== undefined) {
    const directory = path.join(root, '.atris', 'state');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'wishes.jsonl'), contents, 'utf8');
  }
  return root;
}

test('latestWishEventMap keeps the last stored event per id without merging or sorting by timestamp', (t) => {
  const first = { id: 'wish-a', ts: '2025-05-03T12:00:00Z', text: 'original', answer: 'old' };
  const other = { id: 'wish-b', ts: '2025-05-02T12:00:00Z', text: 'another wish' };
  const last = { id: 'wish-a', ts: '2025-05-01T12:00:00Z', status: 'granted' };
  const root = fixture(t, [first, other, last].map(JSON.stringify).join('\n'));

  const result = latestWishEventMap(root);

  assert.ok(result instanceof Map);
  assert.strictEqual(result.size, 2);
  assert.deepStrictEqual(result.get('wish-a'), last);
  assert.deepStrictEqual(result.get('wish-b'), other);
  assert.strictEqual(Object.hasOwn(result.get('wish-a'), 'answer'), false);
});

test('latestWishEventMap skips malformed lines and events without a truthy id', (t) => {
  const event = { id: 'wish-a', text: 'keep this' };
  const root = fixture(t, [
    '',
    '  ',
    '{broken json',
    'null',
    'false',
    '{}',
    JSON.stringify({ id: '' }),
    JSON.stringify({ id: 0 }),
    JSON.stringify({ kind: 'review', wish_id: 'wish-a', review_text: 'separate review' }),
    `  ${JSON.stringify(event)}  `,
    JSON.stringify({ kind: 'steer', wish_id: 'wish-a', note: 'separate steer' }),
    '',
  ].join('\r\n'));

  assert.deepStrictEqual(latestWishEventMap(root), new Map([['wish-a', event]]));
});

test('latestWishEventMap returns an empty Map for missing or empty event files', (t) => {
  const missingRoot = fixture(t);
  const emptyRoot = fixture(t, '');

  assert.deepStrictEqual(latestWishEventMap(missingRoot), new Map());
  assert.deepStrictEqual(latestWishEventMap(emptyRoot), new Map());
});

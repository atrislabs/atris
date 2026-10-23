'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWishEvents } = require('../commands/wish');

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-events-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeEvents(root, lines) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'wishes.jsonl'), lines, 'utf8');
}

test('readWishEvents returns every parsed event in file order', () => {
  withRoot((root) => {
    const events = [
      { id: 'wish-1', n: 1, ts: '2026-01-02T03:04:05.000Z', text: 'ship the thing', status: 'open' },
      { id: 'wish-1', n: 1, ts: '2026-01-02T04:00:00.000Z', kind: 'close', status: 'closed', closed_by: 'operator' },
      { kind: 'review', wish_id: 'wish-1', ts: '2026-01-03T00:00:00.000Z', review_text: 'worked', review_score: 1 },
    ];
    writeEvents(root, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const result = readWishEvents(root);
    assert.deepEqual(result, events);
    assert.equal(result[1].kind, 'close');
    assert.equal(result[2].wish_id, 'wish-1');
  });
});

test('readWishEvents skips malformed and blank lines, keeps CRLF rows', () => {
  withRoot((root) => {
    const good = { id: 'wish-9', ts: '2026-02-01T00:00:00.000Z', text: 'keep me' };
    const other = { kind: 'steer', wish_id: 'wish-9', ts: '2026-02-01T01:00:00.000Z', note: 'left' };
    writeEvents(root, [
      JSON.stringify(good),
      '',
      '   ',
      '{not json',
      JSON.stringify(other) + '\r',
      'null',
      '[1,2,3]',
      '"a string"',
    ].join('\n'));

    const result = readWishEvents(root);
    assert.deepEqual(result, [good, other, [1, 2, 3], 'a string']);
  });
});

test('readWishEvents returns empty array when the state file does not exist', () => {
  withRoot((root) => {
    assert.deepEqual(readWishEvents(root), []);

    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    assert.deepEqual(readWishEvents(root), []);
  });
});

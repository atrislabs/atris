'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parkNextCard } = require('../lib/next-moves');

const STAMP = '2025-04-03T12:00:00.000Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-next-card-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '.atris', 'state', 'next_parked.jsonl') };
}

test('parks a card with its metadata and appends subsequent records', (t) => {
  const { root, file } = fixture(t);
  const card = {
    id: 'card-one', label: 'Review proof', title: 'Review the saved proof',
    source: 'mission', kind: 'mission_ready', status: 'waiting on you',
    next_action: { type: 'mission_review_prompt' },
  };
  const original = JSON.parse(JSON.stringify(card));
  const expected = {
    id: card.id, label: card.label, title: card.title, source: card.source,
    kind: card.kind, status: card.status, at: STAMP,
  };
  assert.deepStrictEqual(parkNextCard(root, card, STAMP), expected);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), `${JSON.stringify(expected)}\n`);
  assert.deepStrictEqual(card, original);

  const second = parkNextCard(root, { id: 'card-two', title: 'Another move', source: 'task' }, STAMP);
  assert.strictEqual(fs.readFileSync(file, 'utf8'),
    `${JSON.stringify(expected)}\n${JSON.stringify(second)}\n`);
});

test('falls back to the title and null metadata without a dreams file', (t) => {
  const { root, file } = fixture(t);
  const card = { id: 'dream-missing', title: 'A thought\nwith "quotes"', label: '', source: 'dream' };
  const expected = {
    id: card.id, label: card.title, title: card.title, source: 'dream',
    kind: null, status: null, at: STAMP,
  };
  assert.deepStrictEqual(parkNextCard(root, card, STAMP), expected);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), expected);
  assert.strictEqual(fs.existsSync(path.join(root, '.atris', 'state', 'dreams.jsonl')), false);
});

test('consumes only the matching unconsumed dream and preserves other lines', (t) => {
  const { root, file } = fixture(t);
  const dreamFile = path.join(root, '.atris', 'state', 'dreams.jsonl');
  fs.mkdirSync(path.dirname(dreamFile), { recursive: true });
  const dream = { source: 'dream', ts: '2025-04-02T12:00:00.000Z', title: 'Try an idea', move: 'Explore it' };
  // Reproduce the stable id from the stored dream fields, without calling another export.
  const key = `dream:${dream.ts}:${dream.title}:${dream.move}`.trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const dreamId = `m_${(hash >>> 0).toString(36)}`;
  const other = JSON.stringify({ ...dream, title: 'Another idea' });
  const consumed = JSON.stringify({ ...dream, consumed_at: '2025-04-02T13:00:00.000Z', consumed_reason: 'dealt' });
  fs.writeFileSync(dreamFile, [JSON.stringify(dream), 'invalid json', other, consumed, ''].join('\n'));

  const row = parkNextCard(root, { id: 'display-id', dream_id: dreamId, title: dream.title, source: 'dream' }, STAMP);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), row);
  assert.strictEqual(fs.readFileSync(dreamFile, 'utf8'), [
    JSON.stringify({ ...dream, consumed_at: STAMP, consumed_reason: 'parked' }),
    'invalid json', other, consumed, '',
  ].join('\n'));
});

test('rejects a null card without appending a parked record', (t) => {
  const { root, file } = fixture(t);
  assert.throws(() => parkNextCard(root, null, STAMP), TypeError);
  assert.strictEqual(fs.existsSync(file), false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markDreamCardConsumed, moveId } = require('../lib/next-moves');

const stamp = '2025-02-03T12:00:00.000Z';
const dream = {
  source: 'dream',
  ts: '2025-02-02T12:00:00.000Z',
  title: 'Make the inbox clearer',
  move: 'Show the next useful action',
  why: 'Reduce reading time',
};
const id = moveId('dream', `${dream.ts}:${dream.title}:${dream.move}`);

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-consumed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.atris', 'state', 'dreams.jsonl');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  return { root, file };
}

test('marks only the matching dream and preserves unrelated and malformed lines', (t) => {
  const other = { ...dream, title: 'Another idea' };
  const nonDream = { ...dream, source: 'inbox' };
  const consumed = { ...dream, consumed_at: '2025-02-02T13:00:00.000Z', consumed_reason: 'parked' };
  const unchanged = [JSON.stringify(other), '{broken json', 'null', JSON.stringify(nonDream), JSON.stringify(consumed)];
  const { root, file } = fixture(t, [JSON.stringify(dream), ...unchanged].join('\n'));

  assert.strictEqual(markDreamCardConsumed(root, { source: 'dream', dream_id: ` ${id} `, id: 'wrong' }, stamp, 'approved'), true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), [
    JSON.stringify({ ...dream, consumed_at: stamp, consumed_reason: 'approved' }),
    ...unchanged,
    '',
  ].join('\n'));
});

test('uses the card id and default reason, and does not consume a dream twice', (t) => {
  const { root, file } = fixture(t, `${JSON.stringify(dream)}\n`);
  const card = { source: 'dream', id };
  assert.strictEqual(markDreamCardConsumed(root, card, stamp), true);
  const saved = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(JSON.parse(saved), { ...dream, consumed_at: stamp, consumed_reason: 'dealt' });
  assert.strictEqual(markDreamCardConsumed(root, card, '2025-02-04T12:00:00.000Z', 'parked'), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), saved);
});

test('returns false without rewriting for invalid cards or unmatched ids', (t) => {
  const original = `${JSON.stringify(dream)}\r\n\r\n`;
  const { root, file } = fixture(t, original);
  for (const card of [null, undefined, {}, { source: 'inbox', id }, { source: 'dream' }, { source: 'dream', id: 'missing' }]) {
    assert.strictEqual(markDreamCardConsumed(root, card, stamp), false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  }
});

test('returns false for missing or empty dream files without creating data', (t) => {
  const { root, file } = fixture(t);
  const card = { source: 'dream', id };
  assert.strictEqual(markDreamCardConsumed(root, card, stamp), false);
  assert.strictEqual(fs.existsSync(path.join(root, '.atris')), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', 'utf8');
  assert.strictEqual(markDreamCardConsumed(root, card, stamp), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
});

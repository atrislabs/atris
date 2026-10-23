'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { latestMissionRecords } = require('../lib/loop-doctor');

test('keeps the last row for each mission id, in first-seen order', () => {
  const rows = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'running' },
    { id: 'a', status: 'completed' },
  ];
  const out = latestMissionRecords(rows);
  assert.deepStrictEqual(out, [
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'running' },
  ]);
  assert.strictEqual(out[0], rows[2]);
  assert.strictEqual(out[1], rows[1]);
});

test('unwraps rows that carry the mission under a mission key', () => {
  const inner = { id: 'm1', status: 'paused' };
  const out = latestMissionRecords([{ ts: '2026-01-01T00:00:00Z', mission: inner }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], inner);
});

test('a later wrapped row replaces an earlier flat row with the same id', () => {
  const out = latestMissionRecords([
    { id: 'm1', status: 'running' },
    { mission: { id: 'm1', status: 'stopped' } },
  ]);
  assert.deepStrictEqual(out, [{ id: 'm1', status: 'stopped' }]);
});

test('falls back to row.mission_id when the mission has no id', () => {
  const out = latestMissionRecords([
    { mission_id: 'm9', mission: { status: 'running' } },
    { mission_id: 'm9', mission: { status: 'done' } },
  ]);
  assert.deepStrictEqual(out, [{ status: 'done' }]);
});

test('stringifies numeric ids so 7 and "7" are the same mission', () => {
  const out = latestMissionRecords([
    { id: 7, status: 'running' },
    { id: '7', status: 'done' },
  ]);
  assert.deepStrictEqual(out, [{ id: '7', status: 'done' }]);
});

test('rows without any id are kept separately, keyed by their position', () => {
  const out = latestMissionRecords([
    { status: 'one' },
    { status: 'two' },
  ]);
  assert.deepStrictEqual(out, [{ status: 'one' }, { status: 'two' }]);
});

test('skips null and non-object rows', () => {
  const out = latestMissionRecords([
    null,
    undefined,
    'text',
    42,
    { id: 'keep', status: 'running' },
    { status: 'no-id' },
  ]);
  assert.deepStrictEqual(out, [
    { id: 'keep', status: 'running' },
    { status: 'no-id' },
  ]);
});

test('a non-object mission value is ignored and the row itself is used', () => {
  const row = { id: 'm2', mission: 'not-an-object', status: 'running' };
  const out = latestMissionRecords([row]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], row);
});

test('empty input gives an empty list', () => {
  assert.deepStrictEqual(latestMissionRecords([]), []);
});

test('input that is not an array throws instead of returning a list', () => {
  assert.throws(() => latestMissionRecords(undefined), TypeError);
  assert.throws(() => latestMissionRecords(null), TypeError);
});

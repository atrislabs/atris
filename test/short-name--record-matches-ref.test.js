'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { recordMatchesRef } = require('../lib/short-name');

test('matches positive record numbers with optional hash and surrounding spaces', () => {
  const record = { n: '12', id: 'mission-alpha-99' };
  assert.strictEqual(recordMatchesRef(record, 12), true);
  assert.strictEqual(recordMatchesRef(record, '  #12  '), true);
  assert.strictEqual(recordMatchesRef(record, '13'), false);
  // Numeric references select the display number, even when the id matches.
  assert.strictEqual(recordMatchesRef({ n: 7, id: '12' }, '12'), false);
});

test('matches exact ids and optional prefix or suffix references', () => {
  const record = { id: 'mission-alpha-tail' };
  assert.strictEqual(recordMatchesRef(record, '  mission-alpha-tail  '), true);
  assert.strictEqual(recordMatchesRef(record, '#mission-alpha-tail', {
    prefix: false, suffix: false,
  }), true);
  assert.strictEqual(recordMatchesRef(record, 'mission'), true);
  assert.strictEqual(recordMatchesRef(record, '#tail'), true);
  assert.strictEqual(recordMatchesRef(record, 'mission', { prefix: false }), false);
  assert.strictEqual(recordMatchesRef(record, 'tail', { suffix: false }), false);
  assert.strictEqual(recordMatchesRef(record, 'tail', { prefix: false }), true);
  assert.strictEqual(recordMatchesRef(record, 'mission', { suffix: false }), true);
  assert.strictEqual(recordMatchesRef(record, 'alpha'), false);
  assert.strictEqual(recordMatchesRef(record, 'MISSION'), false);
});

test('returns false for missing records, empty references, and missing ids', () => {
  assert.strictEqual(recordMatchesRef(null, 'mission'), false);
  assert.strictEqual(recordMatchesRef(undefined, 'mission'), false);
  for (const ref of [undefined, null, '', '   ', 0]) {
    assert.strictEqual(recordMatchesRef({ n: 1, id: 'mission' }, ref), false);
  }
  assert.strictEqual(recordMatchesRef({}, 'mission'), false);
  assert.strictEqual(recordMatchesRef({ id: '   ' }, 'mission'), false);
  assert.strictEqual(recordMatchesRef({ n: 0 }, '#1'), false);
  assert.strictEqual(recordMatchesRef({ n: 1 }, '#1'), true);
});

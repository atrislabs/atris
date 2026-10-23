'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TIMESTAMP } = require('../lib/campaign-schema');

test('TIMESTAMP accepts RFC 3339 strings with a zone', () => {
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00Z'), true);
  assert.equal(TIMESTAMP.test('2026-01-01T00:00:00+05:30'), true);
  assert.equal(TIMESTAMP.test('1999-12-31T23:59:59-08:00'), true);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00.5Z'), true);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00.123456789Z'), true);
});

test('TIMESTAMP captures date, time, fraction, and zone as groups', () => {
  const match = TIMESTAMP.exec('2026-10-15T10:00:00.042+05:30');
  assert.equal(match[1], '2026-10-15');
  assert.equal(match[2], '10:00:00');
  assert.equal(match[3], '042');
  assert.equal(match[4], '+05:30');
  const whole = TIMESTAMP.exec('2026-10-15T10:00:00Z');
  assert.equal(whole[3], undefined);
  assert.equal(whole[4], 'Z');
});

test('TIMESTAMP refuses strings without a zone or in the wrong shape', () => {
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00'), false);
  assert.equal(TIMESTAMP.test('2026-10-15 10:00:00Z'), false);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00Z'), false);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00z'), false);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00+0530'), false);
  assert.equal(TIMESTAMP.test('2026-10-15T10:00:00.1234567890Z'), false);
});

test('TIMESTAMP refuses empty and non-string input', () => {
  assert.equal(TIMESTAMP.test(''), false);
  assert.equal(TIMESTAMP.test('   '), false);
  assert.equal(TIMESTAMP.test(null), false);
  assert.equal(TIMESTAMP.test(undefined), false);
});

test('TIMESTAMP checks shape only, so impossible dates still match', () => {
  assert.equal(TIMESTAMP.test('2026-99-99T99:99:99Z'), true);
});

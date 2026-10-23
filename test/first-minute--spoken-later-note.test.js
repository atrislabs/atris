'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spokenLaterNote } = require('../lib/first-minute');

test('spokenLaterNote normalizes whitespace and removes trailing punctuation', () => {
  assert.strictEqual(
    spokenLaterNote('  Finish\t the checkout\nflow, then review it.!?;:  '),
    'Finish the checkout flow, then review it',
  );
  assert.strictEqual(spokenLaterNote('Keep the API-name (v2)'), 'Keep the API-name (v2)');
});

test('spokenLaterNote returns an empty string for missing or blank notes', () => {
  for (const value of [undefined, null, '', ' \t\r\n ', false, 0, '!?;:,']) {
    assert.strictEqual(spokenLaterNote(value), '', `input: ${String(value)}`);
  }
});

test('spokenLaterNote preserves existing ellipses', () => {
  assert.strictEqual(spokenLaterNote('  Pick this up later...  '), 'Pick this up later...');
});

test('spokenLaterNote clips long notes at a word boundary', () => {
  const prefix = 'a'.repeat(60);
  assert.strictEqual(
    spokenLaterNote(`${prefix} finish the checkout tomorrow`),
    `${prefix} finish...`,
  );
});

test('spokenLaterNote respects the length limit even without word boundaries', () => {
  assert.strictEqual(spokenLaterNote('x'.repeat(72)), 'x'.repeat(72));
  assert.strictEqual(spokenLaterNote('x'.repeat(73)), `${'x'.repeat(69)}...`);
});

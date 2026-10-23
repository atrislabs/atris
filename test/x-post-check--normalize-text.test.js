'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeText } = require('../lib/x-post-check');

test('lowercases and drops punctuation from plain text', () => {
  assert.strictEqual(normalizeText('Hello, World!'), 'hello world');
  assert.strictEqual(normalizeText('Price: $5.00 #tag @user'), 'price 5 00 tag user');
  assert.strictEqual(normalizeText('state-of-the-art'), 'state of the art');
});

test('collapses runs of whitespace and trims the ends', () => {
  assert.strictEqual(normalizeText('  Many   spaces\n\tand\ttabs  '), 'many spaces and tabs');
});

test('removes urls but keeps the words around them', () => {
  assert.strictEqual(normalizeText('Check https://example.com/a?b=1 now'), 'check now');
  assert.strictEqual(normalizeText('http://a.co https://b.co'), '');
});

test('decodes html entities before cleaning', () => {
  assert.strictEqual(
    normalizeText('Tom &amp; Jerry &lt;3 &gt; &quot;hi&quot; it&#39;s'),
    'tom jerry 3 hi its',
  );
});

test('strips apostrophes and backticks without splitting the word', () => {
  assert.strictEqual(
    normalizeText('Don’t stop ‘now’ it\'s `ok`'),
    'dont stop now its ok',
  );
});

test('keeps letters from other languages', () => {
  assert.strictEqual(
    normalizeText('東京は 晴れ! Mañana será'),
    '東京は 晴れ mañana será',
  );
  assert.strictEqual(normalizeText('Ünïcödé ÀÉ'), 'ünïcödé àé');
});

test('returns an empty string when nothing readable is left', () => {
  assert.strictEqual(normalizeText(''), '');
  assert.strictEqual(normalizeText('   '), '');
  assert.strictEqual(normalizeText('!!! ??? ...'), '');
});

test('turns a non-string input into its text form', () => {
  assert.strictEqual(normalizeText(42), '42');
});

test('is stable when run on its own output', () => {
  const once = normalizeText('Shipped &amp; live! https://x.com/a/status/12345 It’s done.');
  assert.strictEqual(once, 'shipped live its done');
  assert.strictEqual(normalizeText(once), once);
});

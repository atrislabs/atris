'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// creditLine itself is pure, but loading lib/design-api resolves a key-file
// path from the home folder and some ATRIS_* settings, so fence both first.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-credit-line-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { creditLine } = require('../lib/design-api');

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('creditLine reports plural credits and the remaining balance', () => {
  const line = creditLine({
    atris: { credits_charged: 5, balance_remaining_usd: 12.5 },
  });
  assert.strictEqual(line, '5 credits charged. $12.50 left.');
});

test('creditLine uses the singular for exactly one credit', () => {
  assert.strictEqual(creditLine({ credits_charged: 1 }), '1 credit charged.');
});

test('creditLine keeps zero as a real number, plural', () => {
  assert.strictEqual(creditLine({ credits_charged: 0 }), '0 credits charged.');
  assert.strictEqual(
    creditLine({ atris: { credits_charged: 0, balance_remaining_usd: 3 } }),
    '0 credits charged. $3.00 left.'
  );
});

test('creditLine falls back to the top-level job price when atris has none', () => {
  assert.strictEqual(creditLine({ credits_charged: 4 }), '4 credits charged.');
  assert.strictEqual(
    creditLine({ credits_charged: 4, atris: { balance_remaining_usd: 0.5 } }),
    '4 credits charged. $0.50 left.'
  );
});

test('creditLine prefers the per-call atris charge over the job price', () => {
  const line = creditLine({
    credits_charged: 10,
    atris: { credits_charged: 2, balance_remaining_usd: 7 },
  });
  assert.strictEqual(line, '2 credits charged. $7.00 left.');
});

test('creditLine accepts numeric strings and rounds the balance to cents', () => {
  const line = creditLine({
    atris: { credits_charged: '3', balance_remaining_usd: '1.234' },
  });
  assert.strictEqual(line, '3 credits charged. $1.23 left.');
});

test('creditLine shows a question mark when the charge is missing', () => {
  assert.strictEqual(creditLine({}), '? charged.');
  assert.strictEqual(creditLine({ atris: {} }), '? charged.');
  assert.strictEqual(
    creditLine({ atris: { balance_remaining_usd: 9 } }),
    '? charged. $9.00 left.'
  );
});

test('creditLine treats unusable charge values as unknown', () => {
  assert.strictEqual(creditLine({ credits_charged: 'abc' }), '? charged.');
  assert.strictEqual(creditLine({ credits_charged: NaN }), '? charged.');
  assert.strictEqual(creditLine({ credits_charged: Infinity }), '? charged.');
  assert.strictEqual(creditLine({ credits_charged: {} }), '? charged.');
});

test('creditLine does not throw on empty or non-object input', () => {
  assert.strictEqual(creditLine(), '? charged.');
  assert.strictEqual(creditLine(undefined), '? charged.');
  assert.strictEqual(creditLine(null), '? charged.');
  assert.strictEqual(creditLine('5 credits'), '? charged.');
  assert.strictEqual(creditLine(42), '? charged.');
});

test('creditLine ignores an atris block that is not an object', () => {
  assert.strictEqual(
    creditLine({ credits_charged: 6, atris: 'oops' }),
    '6 credits charged.'
  );
  assert.strictEqual(
    creditLine({ credits_charged: 6, atris: null }),
    '6 credits charged.'
  );
});

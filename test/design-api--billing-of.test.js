'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Loading the client resolves its key-file path, so isolate that from local state.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-of-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;
let billingOf;
try {
  ({ billingOf } = require('../lib/design-api'));
} finally {
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
}

test('billingOf prefers call billing over the job price and converts numeric strings', () => {
  assert.deepStrictEqual(billingOf({
    credits_charged: 50,
    atris: { credits_charged: '2.5', balance_remaining_usd: '12.75' },
  }), { credits: 2.5, balanceUsd: 12.75 });
});

test('billingOf preserves zero and falls back only for missing or null call credits', () => {
  assert.deepStrictEqual(billingOf({
    credits_charged: 50,
    atris: { credits_charged: 0, balance_remaining_usd: 0 },
  }), { credits: 0, balanceUsd: 0 });
  for (const atris of [{}, { credits_charged: null }]) {
    assert.deepStrictEqual(billingOf({ credits_charged: 3, atris }),
      { credits: 3, balanceUsd: null });
  }
});

test('billingOf returns unknown amounts for empty and non-object responses', () => {
  assert.deepStrictEqual(billingOf(), { credits: null, balanceUsd: null });
  for (const input of [{}, null, undefined, '', 'bad response', 42, false, []]) {
    assert.deepStrictEqual(billingOf(input), { credits: null, balanceUsd: null });
  }
});

test('billingOf rejects non-finite billing amounts without falling back to the job price', () => {
  for (const value of ['invalid', NaN, Infinity, -Infinity]) {
    assert.deepStrictEqual(billingOf({
      credits_charged: 9,
      atris: { credits_charged: value, balance_remaining_usd: value },
    }), { credits: null, balanceUsd: null });
  }
  assert.deepStrictEqual(billingOf({ credits_charged: 4, atris: 'invalid' }),
    { credits: 4, balanceUsd: null });
});

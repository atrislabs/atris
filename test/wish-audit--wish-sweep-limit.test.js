'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let wishAudit;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-sweep-limit-'));
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  wishAudit = require('../lib/wish-audit');
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('WISH_SWEEP_LIMIT is the number three, not a function', () => {
  const { WISH_SWEEP_LIMIT } = wishAudit;
  assert.strictEqual(typeof WISH_SWEEP_LIMIT, 'number');
  assert.strictEqual(WISH_SWEEP_LIMIT, 3);
  assert.throws(() => WISH_SWEEP_LIMIT(), TypeError);
});

test('WISH_SWEEP_LIMIT is a whole number a sweep can use as its default cap', () => {
  const { WISH_SWEEP_LIMIT } = wishAudit;
  assert.ok(Number.isInteger(WISH_SWEEP_LIMIT), 'must be an integer');
  assert.ok(WISH_SWEEP_LIMIT > 0, 'a zero cap would make every sweep dispatch nothing');
  // sweepWishes only falls back to this value when options.limit fails this same check
  assert.ok(Number.isInteger(WISH_SWEEP_LIMIT) && WISH_SWEEP_LIMIT >= 0);
});

test('WISH_SWEEP_LIMIT stays the same value across repeated reads of the module', () => {
  const first = require('../lib/wish-audit').WISH_SWEEP_LIMIT;
  const second = require('../lib/wish-audit').WISH_SWEEP_LIMIT;
  assert.strictEqual(first, second);
  assert.strictEqual(first, wishAudit.WISH_SWEEP_LIMIT);
});

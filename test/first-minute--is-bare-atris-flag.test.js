'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let isBareAtrisFlag;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bare-flag-'));
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  ({ isBareAtrisFlag } = require('../lib/first-minute'));
});

after(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('isBareAtrisFlag accepts each known bare flag', () => {
  for (const flag of ['--yes', '-y', '--json', '--verbose']) {
    assert.strictEqual(isBareAtrisFlag(flag), true, flag);
  }
});

test('isBareAtrisFlag rejects real commands and unknown flags', () => {
  for (const token of ['task', 'help', '--help', '-v', '--version', '--Yes', '-Y', 'yes', '-yes']) {
    assert.strictEqual(isBareAtrisFlag(token), false, token);
  }
});

test('isBareAtrisFlag does not trim or partially match', () => {
  assert.strictEqual(isBareAtrisFlag(' --yes'), false);
  assert.strictEqual(isBareAtrisFlag('--yes '), false);
  assert.strictEqual(isBareAtrisFlag('--json=true'), false);
  assert.strictEqual(isBareAtrisFlag('--yes --json'), false);
});

test('isBareAtrisFlag returns false for empty and missing input', () => {
  for (const token of [undefined, null, '', 0, false, NaN]) {
    assert.strictEqual(isBareAtrisFlag(token), false, String(token));
  }
});

test('isBareAtrisFlag coerces non-string input to a string before matching', () => {
  assert.strictEqual(isBareAtrisFlag({ toString: () => '--verbose' }), true);
  assert.strictEqual(isBareAtrisFlag(['-y']), true);
  assert.strictEqual(isBareAtrisFlag(['--yes', '--json']), false);
  assert.strictEqual(isBareAtrisFlag({}), false);
});

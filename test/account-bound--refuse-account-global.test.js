'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-refuse-account-global-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

const { refuseAccountGlobal, ACCOUNT_GLOBAL_MESSAGE } = require('../lib/account-bound');

test('refuseAccountGlobal calls custom writer and returns exit code 2', () => {
  const logged = [];
  const writer = (msg) => {
    logged.push(msg);
  };

  const code = refuseAccountGlobal(writer);

  assert.strictEqual(code, 2);
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0], ACCOUNT_GLOBAL_MESSAGE);
  assert.strictEqual(logged[0], 'account-global; pass --account to continue');
});

test('refuseAccountGlobal defaults to console.error when no writer is provided', () => {
  const originalError = console.error;
  const captured = [];
  console.error = (msg) => {
    captured.push(msg);
  };

  try {
    const code = refuseAccountGlobal();
    assert.strictEqual(code, 2);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0], ACCOUNT_GLOBAL_MESSAGE);
  } finally {
    console.error = originalError;
  }
});

test('refuseAccountGlobal edge cases with explicit undefined or repeated calls', () => {
  const originalError = console.error;
  const captured = [];
  console.error = (msg) => {
    captured.push(msg);
  };

  try {
    const code = refuseAccountGlobal(undefined);
    assert.strictEqual(code, 2);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0], ACCOUNT_GLOBAL_MESSAGE);
  } finally {
    console.error = originalError;
  }

  const logged = [];
  const writer = (msg) => logged.push(msg);
  assert.strictEqual(refuseAccountGlobal(writer), 2);
  assert.strictEqual(refuseAccountGlobal(writer), 2);
  assert.strictEqual(logged.length, 2);
  assert.deepStrictEqual(logged, [ACCOUNT_GLOBAL_MESSAGE, ACCOUNT_GLOBAL_MESSAGE]);
});

test('refuseAccountGlobal throws TypeError when passed an invalid writer', () => {
  assert.throws(() => {
    refuseAccountGlobal(null);
  }, {
    name: 'TypeError',
  });

  assert.throws(() => {
    refuseAccountGlobal(123);
  }, {
    name: 'TypeError',
  });
});

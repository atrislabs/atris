'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { truncateLine } = require('../commands/now');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-now-truncate-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return root;
}

function cleanupIsolatedEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('truncateLine: handles normal inputs within and beyond maximum length', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(truncateLine('short text', 20), 'short text');
    assert.strictEqual(truncateLine('exact length', 12), 'exact length');
    assert.strictEqual(truncateLine('hello world from atris', 12), 'hello world…');
    assert.strictEqual(
      truncateLine('   alpha   beta   gamma   ', 30),
      'alpha beta gamma'
    );
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('truncateLine: handles boundary edge cases and trailing whitespace before ellipsis', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(truncateLine('alpha beta gamma', 12), 'alpha beta…');
    assert.strictEqual(truncateLine('hello', 1), '…');
    assert.strictEqual(
      truncateLine('first line\n\tsecond line\nthird line', 25),
      'first line second line t…'
    );
    assert.strictEqual(truncateLine(123456, 4), '123…');
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('truncateLine: handles empty, falsy, and whitespace-only inputs', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(truncateLine('', 10), '');
    assert.strictEqual(truncateLine('   \t\n  ', 10), '');
    assert.strictEqual(truncateLine(null, 10), '');
    assert.strictEqual(truncateLine(undefined, 10), '');
    assert.strictEqual(truncateLine(false, 10), '');
  } finally {
    cleanupIsolatedEnv(root);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dreamsPath } = require('../commands/dream');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dreams-path-'));
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

test('dreamsPath: returns correct path for normal root directory', () => {
  const root = setupIsolatedEnv();
  try {
    const expected = path.join(root, '.atris', 'state', 'dreams.jsonl');
    const actual = dreamsPath(root);

    assert.strictEqual(actual, expected);

    fs.mkdirSync(path.dirname(actual), { recursive: true });
    fs.writeFileSync(actual, '{"ts":"2026-01-01T00:00:00.000Z"}\n', 'utf8');

    assert.strictEqual(fs.existsSync(expected), true);
    assert.strictEqual(fs.readFileSync(actual, 'utf8').trim(), '{"ts":"2026-01-01T00:00:00.000Z"}');
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('dreamsPath: handles edge cases like trailing separators and relative paths', () => {
  const root = setupIsolatedEnv();
  try {
    const rootWithSlash = root + path.sep;
    const expectedNormalized = path.join(root, '.atris', 'state', 'dreams.jsonl');
    assert.strictEqual(dreamsPath(rootWithSlash), expectedNormalized);

    const relativeResult = dreamsPath('.');
    const expectedRelative = path.join('.', '.atris', 'state', 'dreams.jsonl');
    assert.strictEqual(relativeResult, expectedRelative);

    const nestedRelative = dreamsPath(path.join('nested', 'workspace'));
    const expectedNested = path.join('nested', 'workspace', '.atris', 'state', 'dreams.jsonl');
    assert.strictEqual(nestedRelative, expectedNested);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('dreamsPath: handles empty string and throws TypeError on missing or invalid root', () => {
  const emptyResult = dreamsPath('');
  const expectedEmpty = path.join('', '.atris', 'state', 'dreams.jsonl');
  assert.strictEqual(emptyResult, expectedEmpty);

  assert.throws(() => dreamsPath(), {
    name: 'TypeError',
  });

  assert.throws(() => dreamsPath(undefined), {
    name: 'TypeError',
  });

  assert.throws(() => dreamsPath(null), {
    name: 'TypeError',
  });
});

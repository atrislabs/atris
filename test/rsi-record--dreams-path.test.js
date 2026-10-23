'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dreamsPath } = require('../lib/rsi-record');

const ENV_KEY = 'ATRIS_RSI_STATE';

function withEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

test('dreamsPath defaults to dreams.jsonl under <root>/.atris/state/rsi', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-path-'));
  try {
    const got = withEnv(undefined, () => dreamsPath(root));
    assert.strictEqual(got, path.join(root, '.atris', 'state', 'rsi', 'dreams.jsonl'));
    assert.strictEqual(path.basename(got), 'dreams.jsonl');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dreamsPath is pure: it builds a path and never creates anything on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-path-'));
  try {
    withEnv(undefined, () => dreamsPath(root));
    assert.deepStrictEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dreamsPath honors ATRIS_RSI_STATE and ignores the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-path-'));
  const state = path.join(root, 'custom-state');
  try {
    const got = withEnv(state, () => dreamsPath(path.join(root, 'unrelated')));
    assert.strictEqual(got, path.join(state, 'dreams.jsonl'));
    assert.ok(!got.includes('unrelated'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dreamsPath treats an empty ATRIS_RSI_STATE as unset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-path-'));
  try {
    const got = withEnv('', () => dreamsPath(root));
    assert.strictEqual(got, path.join(root, '.atris', 'state', 'rsi', 'dreams.jsonl'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dreamsPath normalizes a trailing slash on the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreams-path-'));
  try {
    const got = withEnv(undefined, () => dreamsPath(root + path.sep));
    assert.strictEqual(got, path.join(root, '.atris', 'state', 'rsi', 'dreams.jsonl'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dreamsPath throws a TypeError when root is missing and no env override is set', () => {
  assert.throws(() => withEnv(undefined, () => dreamsPath(undefined)), TypeError);
  assert.throws(() => withEnv(undefined, () => dreamsPath(null)), TypeError);
});

test('dreamsPath does not need a root when ATRIS_RSI_STATE is set', () => {
  const state = path.join(os.tmpdir(), 'dreams-path-env-only');
  const got = withEnv(state, () => dreamsPath(undefined));
  assert.strictEqual(got, path.join(state, 'dreams.jsonl'));
});

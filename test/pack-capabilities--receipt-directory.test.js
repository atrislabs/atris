'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { receiptDirectory } = require('../lib/pack-capabilities');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-receipt-directory-'));
const FAKE_HOME = path.join(ROOT, 'home');
fs.mkdirSync(FAKE_HOME);

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// Runs fn with every ATRIS_* var cleared, HOME pointed at the temp home, and
// the given overrides applied. The previous values are put back afterwards.
function withEnv(overrides, fn) {
  const keys = new Set([
    ...Object.keys(process.env).filter((key) => key.startsWith('ATRIS_')),
    'HOME',
    ...Object.keys(overrides),
  ]);
  const saved = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.HOME = FAKE_HOME;
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved.get(key) === undefined) delete process.env[key];
      else process.env[key] = saved.get(key);
    }
  }
}

test('an explicit receiptDir wins over the env var and is made absolute', () => {
  withEnv({ ATRIS_PACK_RUNS_DIR: path.join(ROOT, 'from-env') }, () => {
    const explicit = path.join(ROOT, 'explicit', '..', 'runs');
    assert.strictEqual(receiptDirectory({ receiptDir: explicit }), path.join(ROOT, 'runs'));
    assert.strictEqual(
      receiptDirectory({ receiptDir: 'rel/runs' }),
      path.join(process.cwd(), 'rel', 'runs'),
    );
  });
});

test('ATRIS_PACK_RUNS_DIR is used when no receiptDir is given', () => {
  withEnv({ ATRIS_PACK_RUNS_DIR: path.join(ROOT, 'env-runs', '.') }, () => {
    assert.strictEqual(receiptDirectory(), path.join(ROOT, 'env-runs'));
    assert.strictEqual(receiptDirectory({}), path.join(ROOT, 'env-runs'));
  });
});

test('with nothing set, the default is .atris/runs/packs under HOME', () => {
  withEnv({}, () => {
    const expected = path.join(FAKE_HOME, '.atris', 'runs', 'packs');
    assert.strictEqual(receiptDirectory(), expected);
    assert.strictEqual(receiptDirectory({}), expected);
  });
});

test('empty values fall through to the next choice instead of resolving to ""', () => {
  withEnv({ ATRIS_PACK_RUNS_DIR: '' }, () => {
    const expected = path.join(FAKE_HOME, '.atris', 'runs', 'packs');
    assert.strictEqual(receiptDirectory({ receiptDir: '' }), expected);
    assert.strictEqual(receiptDirectory(), expected);
  });
});

test('it only names a directory and does not create it', () => {
  withEnv({}, () => {
    const dir = path.join(ROOT, 'never-made', 'runs');
    assert.strictEqual(receiptDirectory({ receiptDir: dir }), dir);
    assert.strictEqual(fs.existsSync(dir), false);
  });
});

test('a non-string receiptDir throws a TypeError rather than picking a folder', () => {
  withEnv({}, () => {
    assert.throws(
      () => receiptDirectory({ receiptDir: 42 }),
      { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' },
    );
  });
});

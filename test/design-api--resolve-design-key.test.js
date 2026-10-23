'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const savedEnv = {};
let tmpHome;
let keyFile;
let resolveDesignKey;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-design-key-'));
  keyFile = path.join(tmpHome, '.atris', 'design-api-key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tmpHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  ({ resolveDesignKey } = require('../lib/design-api'));
});

after(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') && !(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Stub deps that record calls so a test can prove a later source was skipped.
function stubDeps({ creds = null, fileKey = null } = {}) {
  const calls = { creds: 0, file: 0 };
  return {
    calls,
    loadCredentials: () => { calls.creds += 1; return creds; },
    readKeyFile: () => { calls.file += 1; return fileKey; },
  };
}

test('env key wins and is trimmed without touching other sources', () => {
  const deps = stubDeps({ creds: { token: 'from-creds' }, fileKey: 'from-file' });
  const key = resolveDesignKey({ ATRIS_API_KEY: '  env-key-123 \n' }, deps);
  assert.strictEqual(key, 'env-key-123');
  assert.deepStrictEqual(deps.calls, { creds: 0, file: 0 });
});

test('blank env key falls through to the login token, trimmed', () => {
  const deps = stubDeps({ creds: { token: '  login-token\t' }, fileKey: 'from-file' });
  assert.strictEqual(resolveDesignKey({ ATRIS_API_KEY: '   ' }, deps), 'login-token');
  assert.strictEqual(deps.calls.creds, 1);
  assert.strictEqual(deps.calls.file, 0);
});

test('missing env var uses the login token', () => {
  const deps = stubDeps({ creds: { token: 'login-token' } });
  assert.strictEqual(resolveDesignKey({}, deps), 'login-token');
});

test('unusable credentials fall through to the key file', () => {
  const badCreds = [null, undefined, {}, { token: '' }, { token: '   ' }, { token: 42 }, { token: null }];
  for (const creds of badCreds) {
    const deps = stubDeps({ creds, fileKey: 'file-key' });
    assert.strictEqual(
      resolveDesignKey({}, deps),
      'file-key',
      `creds ${JSON.stringify(creds)} should fall through`
    );
    assert.strictEqual(deps.calls.file, 1);
  }
});

test('returns null when no source has a key', () => {
  const deps = stubDeps();
  assert.strictEqual(resolveDesignKey({}, deps), null);
  assert.deepStrictEqual(deps.calls, { creds: 1, file: 1 });
});

test('returns exactly what the key file reader gives back', () => {
  const deps = stubDeps({ fileKey: 'only-in-file' });
  assert.strictEqual(resolveDesignKey({ ATRIS_API_KEY: '' }, deps), 'only-in-file');
});

test('default key file reader trims the file and returns null when empty or missing', () => {
  const noCreds = { loadCredentials: () => null };

  fs.writeFileSync(keyFile, '  file-secret-key \n');
  assert.strictEqual(resolveDesignKey({}, noCreds), 'file-secret-key');

  fs.writeFileSync(keyFile, ' \n\t');
  assert.strictEqual(resolveDesignKey({}, noCreds), null);

  fs.rmSync(keyFile, { force: true });
  assert.strictEqual(resolveDesignKey({}, noCreds), null);
});

test('env key still beats the default key file', () => {
  fs.writeFileSync(keyFile, 'file-secret-key');
  try {
    assert.strictEqual(
      resolveDesignKey({ ATRIS_API_KEY: 'env-wins' }, { loadCredentials: () => null }),
      'env-wins'
    );
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
});

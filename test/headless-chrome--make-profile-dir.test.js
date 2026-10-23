'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeProfileDir, removeProfileDir, headlessArgs } = require('../lib/headless-chrome');

// os.tmpdir() reads these on every call, so point them at a sandbox we own.
const TMP_VARS = ['TMPDIR', 'TMP', 'TEMP'];
const saved = {};
for (const name of TMP_VARS) saved[name] = process.env[name];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-make-profile-dir-test-'));
for (const name of TMP_VARS) process.env[name] = sandbox;

test.after(() => {
  for (const name of TMP_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('makeProfileDir creates an empty directory under the temp folder with the default prefix', () => {
  const dir = makeProfileDir();
  assert.strictEqual(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith('atris-chrome-'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('makeProfileDir honors a custom prefix', () => {
  const dir = makeProfileDir('atris-card-chrome-');
  assert.strictEqual(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith('atris-card-chrome-'));
  assert.ok(!path.basename(dir).startsWith('atris-chrome-'));
  assert.ok(fs.statSync(dir).isDirectory());
});

test('makeProfileDir returns a fresh unique directory on every call', () => {
  const first = makeProfileDir('atris-unique-');
  const second = makeProfileDir('atris-unique-');
  assert.notStrictEqual(first, second);
  assert.ok(fs.existsSync(first));
  assert.ok(fs.existsSync(second));
});

test('makeProfileDir with an empty prefix lands beside the temp folder, not inside it', () => {
  // mkdtemp appends its random suffix straight onto the joined path, so with no
  // prefix the new folder is a sibling of the temp folder. Nest the temp folder
  // so that sibling still lands inside the sandbox.
  const nested = path.join(sandbox, 'nested-tmp');
  fs.mkdirSync(nested);
  for (const name of TMP_VARS) process.env[name] = nested;
  try {
    const dir = makeProfileDir('');
    assert.strictEqual(path.dirname(dir), sandbox);
    assert.ok(path.basename(dir).startsWith('nested-tmp'));
    assert.ok(path.basename(dir).length > 'nested-tmp'.length);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.throws(() => headlessArgs(dir), /throwaway profile/);
  } finally {
    for (const name of TMP_VARS) process.env[name] = sandbox;
  }
});

test('makeProfileDir output is accepted by headlessArgs and removed by removeProfileDir', () => {
  const dir = makeProfileDir('atris-roundtrip-');
  const args = headlessArgs(dir);
  assert.ok(args.includes(`--user-data-dir=${path.resolve(dir)}`));
  removeProfileDir(dir);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('makeProfileDir throws when the temp folder does not exist', () => {
  const missing = path.join(sandbox, 'does-not-exist');
  for (const name of TMP_VARS) process.env[name] = missing;
  try {
    assert.throws(() => makeProfileDir(), { code: 'ENOENT' });
  } finally {
    for (const name of TMP_VARS) process.env[name] = sandbox;
  }
});

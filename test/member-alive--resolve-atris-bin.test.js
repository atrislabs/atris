'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-resolve-atris-bin-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { resolveAtrisBin } = require('../lib/member-alive');

const localBin = path.join(path.dirname(require.resolve('../lib/member-alive')), '..', 'bin', 'atris.js');

function clearAtrisEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
}

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('resolveAtrisBin returns an explicit bin unchanged', () => {
  clearAtrisEnv();
  process.env.ATRIS_BIN = path.join(home, 'from-env.js');
  const explicit = path.join(home, 'bin', 'atris.js');
  assert.strictEqual(resolveAtrisBin(explicit), explicit);
  assert.strictEqual(resolveAtrisBin('./custom-atris'), './custom-atris');
  assert.strictEqual(resolveAtrisBin('atris'), 'atris');
});

test('resolveAtrisBin uses ATRIS_BIN only when no explicit bin is given', () => {
  clearAtrisEnv();
  const fromEnv = path.join(home, 'env-atris');
  process.env.ATRIS_BIN = fromEnv;
  assert.strictEqual(resolveAtrisBin(), fromEnv);
  assert.strictEqual(resolveAtrisBin(undefined), fromEnv);
  process.env.ATRIS_BIN = 'relative/atris';
  assert.strictEqual(resolveAtrisBin(null), 'relative/atris');
  assert.strictEqual(resolveAtrisBin(' '), ' ');
});

test('resolveAtrisBin falls back when the explicit bin and ATRIS_BIN are empty', () => {
  clearAtrisEnv();
  process.env.ATRIS_BIN = '';
  const expected = fs.existsSync(localBin) ? localBin : 'atris';
  assert.strictEqual(resolveAtrisBin(''), expected);
  assert.strictEqual(resolveAtrisBin(null), expected);
  assert.strictEqual(resolveAtrisBin(undefined), expected);
  delete process.env.ATRIS_BIN;
  assert.strictEqual(resolveAtrisBin(), expected);
  if (expected !== 'atris') {
    assert.strictEqual(path.basename(expected), 'atris.js');
    assert.strictEqual(fs.existsSync(expected), true);
  }
});

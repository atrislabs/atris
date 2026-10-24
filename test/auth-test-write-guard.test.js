'use strict';

// 2026-10-23: a mutant test forgot to point HOME at a scratch dir, minted a
// fake token through the real save path, and logged the owner out. Under a
// test runner, login files may only be written inside the OS temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertSafeLoginWrite, saveCredentials } = require('../utils/auth');

function withHome(home, fn) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test('login write outside the temp dir is refused during tests', () => {
  const outside = path.join(path.resolve(__dirname, '..'), '.not-a-real-home', '.atris', 'credentials.json');
  assert.throws(() => assertSafeLoginWrite(outside), /Refusing to write .* during a test/);
});

test('saveCredentials with HOME left on a non-temp dir writes nothing', () => {
  const fakeHome = fs.mkdtempSync(path.join(path.resolve(__dirname, '..'), '.guard-home-'));
  try {
    withHome(fakeHome, () => {
      assert.throws(() => saveCredentials('fake-token', 'rt'), /Refusing to write/);
    });
    assert.equal(fs.existsSync(path.join(fakeHome, '.atris', 'credentials.json')), false);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('saveCredentials into a temp HOME still works', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-guard-'));
  try {
    withHome(home, () => saveCredentials('fake-token', 'rt'));
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'credentials.json'), 'utf8'));
    assert.equal(saved.token, 'fake-token');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

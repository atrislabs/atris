'use strict';

// removeProfileDir is the cleanup half of the headless Chrome profile
// lifecycle: launch spots call it when Chrome exits, so it must delete a
// throwaway profile tree and stay quiet when the path is already gone or
// was never a real dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { removeProfileDir } = require('../lib/headless-chrome');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
}

test('removeProfileDir deletes a profile dir with nested files', () => {
  const dir = path.join(tmpdir(), 'profile');
  fs.mkdirSync(path.join(dir, 'Default', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'x');
  fs.writeFileSync(path.join(dir, 'lockfile'), 'x');

  removeProfileDir(dir);

  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.dirname(dir)));
});

test('removeProfileDir on a missing path does not throw', () => {
  const gone = path.join(tmpdir(), 'never-existed');
  assert.doesNotThrow(() => removeProfileDir(gone));
  assert.equal(fs.existsSync(gone), false);
});

test('removeProfileDir on a plain file removes it without throwing', () => {
  const file = path.join(tmpdir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.doesNotThrow(() => removeProfileDir(file));
  assert.equal(fs.existsSync(file), false);
});

test('removeProfileDir swallows bad input instead of throwing', () => {
  assert.doesNotThrow(() => removeProfileDir(undefined));
  assert.doesNotThrow(() => removeProfileDir(null));
});

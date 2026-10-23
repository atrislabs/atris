const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectDoctor } = require('../commands/doctor');

test('marks bin as non-shim when size reaches or exceeds 2048 bytes', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-test-'));
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;

  const origStatSync = fs.statSync;
  t.after(() => {
    fs.statSync = origStatSync;
  });

  fs.statSync = function (targetPath, options) {
    if (typeof targetPath === 'string' && targetPath.endsWith(path.sep + path.join('bin', 'atris'))) {
      return { size: 2048 };
    }
    return origStatSync.call(fs, targetPath, options);
  };

  const payload = collectDoctor({ cwd: tmp, binInstalled: () => false });
  assert.equal(payload.bin.shim, false);
});

test('marks bin as non-shim when bin file is missing', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-test-'));
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;

  const origStatSync = fs.statSync;
  t.after(() => {
    fs.statSync = origStatSync;
  });

  fs.statSync = function (targetPath, options) {
    if (typeof targetPath === 'string' && targetPath.endsWith(path.sep + path.join('bin', 'atris'))) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return origStatSync.call(fs, targetPath, options);
  };

  const payload = collectDoctor({ cwd: tmp, binInstalled: () => false });
  assert.equal(payload.bin.shim, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectDoctor } = require('../commands/doctor');

test('a public launcher of exactly 2048 bytes is not a shim', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-shim-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = path.join(root, 'launcher');
  fs.writeFileSync(launcher, Buffer.alloc(2048, 'x'));
  const launcherStat = fs.statSync(launcher);
  const publicLauncher = path.resolve(__dirname, '../bin/atris');
  const originalStatSync = fs.statSync;
  const statMock = t.mock.method(fs, 'statSync', function (file, ...args) {
    if (file === publicLauncher) return launcherStat;
    return originalStatSync.call(this, file, ...args);
  });

  let result;
  try {
    result = collectDoctor({
      cwd: root,
      packageRoot: root,
      nodeVersion: '22.0.0',
      binInstalled: () => false,
    });
  } finally {
    statMock.mock.restore();
  }

  assert.equal(result.bin.shim_bytes, 2048);
  assert.equal(result.bin.shim, false);
});

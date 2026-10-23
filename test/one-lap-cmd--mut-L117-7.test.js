'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOneLap } = require('../commands/one-lap');

test('runOneLap propagates the exact lock creation error when the lock folder denies writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lap-lock-error-'));
  const locks = path.join(root, '.atris', 'state', 'one-lap-locks');
  const ask = 'deploy to production';
  let lockPath;
  try {
    // The refused request takes a lock but cannot dispatch any engine work.
    await runOneLap(ask, {
      root,
      quiet: true,
      onResult() {
        const names = fs.readdirSync(locks);
        assert.equal(names.length, 1);
        lockPath = path.join(locks, names[0]);
      },
    });
    fs.chmodSync(locks, 0o500);

    // Capture the platform's exact native error for this same file operation.
    let expected;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
    } catch (error) {
      expected = error;
    }
    assert.equal(expected && expected.code, 'EACCES');

    await assert.rejects(runOneLap(ask, {
      root,
      quiet: true,
      ownCli() { assert.fail('must not run CLI commands'); },
      progress() { assert.fail('must not start engine work'); },
    }), (error) => {
      assert.deepEqual(error, expected);
      assert.equal(error.message, expected.message);
      return true;
    });
  } finally {
    if (fs.existsSync(locks)) fs.chmodSync(locks, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

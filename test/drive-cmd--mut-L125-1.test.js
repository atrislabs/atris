'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const origSpawnSync = cp.spawnSync;
let spawnSyncHandler = null;

cp.spawnSync = function (file, args, ...rest) {
  if (spawnSyncHandler) {
    return spawnSyncHandler(file, args, ...rest);
  }
  return origSpawnSync.call(cp, file, args, ...rest);
};

const { driveCommand } = require('../commands/drive');

test('stale ready receipt with successful tick is marked as fixed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-drive-mut-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const origLog = console.log;
  const origExit = process.exit;
  const lines = [];

  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => {
      throw new Error(`process.exit: ${code}`);
    };

    spawnSyncHandler = (_file, args) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv.includes('doctor')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            checked_count: 1,
            findings: [{ code: 'stale_ready_receipt', mission_id: 'm-1' }],
          }),
          stderr: '',
        };
      }
      if (argv.includes('tick')) {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const code = await driveCommand(['--json']);
    assert.equal(code, 0);

    const payload = JSON.parse(lines.join('\n'));
    assert.equal(payload.fixed, 1);
    assert.equal(payload.disengagements, 0);
  } finally {
    spawnSyncHandler = null;
    console.log = origLog;
    process.exit = origExit;
    process.chdir(prevCwd);
    if (prevHome !== undefined) {
      process.env.HOME = prevHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { statusCommand } = require('../commands/pulse');

test('statusCommand uses provided spawnSync for checking legacy cron installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-test-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-test-'));
  process.env.HOME = homeDir;

  try {
    const probe = statusCommand([], root, {
      homeDir,
      spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
      writeOutput: () => {},
    });
    const marker = probe.marker;

    const fakeSpawnSync = (command, args) => {
      if (command === 'crontab' && Array.isArray(args) && args[0] === '-l') {
        return {
          status: 0,
          stdout: `* * * * * /tmp/tick.sh # ${marker}\n`,
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    };

    const status = statusCommand([], root, {
      homeDir,
      spawnSync: fakeSpawnSync,
      writeOutput: () => {},
    });

    assert.strictEqual(status.legacy_cron_installed, true);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

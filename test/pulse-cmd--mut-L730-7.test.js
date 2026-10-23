'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCommand } = require('../commands/pulse');
const { resolvePulseSlot } = require('../lib/pulse');

test('install removes the old heartbeat schedule while preserving unrelated jobs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-migrate-cron-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const stdout = process.stdout.write;
  const exit = process.exit;
  process.env.HOME = root;
  process.chdir(root);
  process.stdout.write = () => true;
  process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    const { marker } = resolvePulseSlot(root, { homeDir: root });
    const unrelated = '0 3 * * * /usr/bin/true # nightly-maintenance';
    let crontab = `${unrelated}\n*/20 * * * * "${root}/tick.sh" # ${marker}\n`;
    installCommand(['--hours', '1', '--no-keep-awake'], root, {
      homeDir: root,
      uid: 501,
      writeOutput: () => {},
      spawnSync(command, args, options) {
        if (command === 'which') return { status: 1, stdout: '', stderr: '' };
        if (command === 'launchctl') return { status: 0, stdout: '', stderr: '' };
        if (command === 'crontab' && args[0] === '-l') return { status: 0, stdout: crontab, stderr: '' };
        if (command === 'crontab' && args[0] === '-') {
          crontab = options.input;
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    });
    assert.equal(crontab.includes(marker), false);
    assert.equal(crontab.includes('nightly-maintenance'), true);
  } finally {
    process.stdout.write = stdout;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

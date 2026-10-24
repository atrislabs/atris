'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('an idle heartbeat leaves its configured check unrun', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-idle-check-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const spawn = childProcess.spawnSync;
  const write = process.stdout.write;
  const exit = process.exit;
  try {
    process.env.HOME = root;
    process.chdir(root);
    childProcess.spawnSync = (command, args, options) => {
      if (command === process.execPath && args[1] === 'mission') {
        return { status: 0, stdout: JSON.stringify({ reason: 'no_due_mission' }), stderr: '' };
      }
      return spawn(command, args, options);
    };
    process.stdout.write = () => true;
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { pulseCommand } = require('../commands/pulse');
    const result = pulseCommand([
      'tick', '--no-claude', '--no-campaigns', '--no-autopilot', '--json',
      '--verify', 'exit 1',
    ]);
    assert.strictEqual(result.verify_passed, null);
  } finally {
    childProcess.spawnSync = spawn;
    process.stdout.write = write;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  }
});

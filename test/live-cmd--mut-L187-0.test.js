require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { liveCommand } = require('../commands/live');

test('a failed startup pull rejects with its child exit status', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-exit-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    console.log = () => {};
    await assert.rejects(
      liveCommand(['example-business', '--once', '--no-doctor', '--no-push']),
      /\bpull\b.*\bexited 1\b/
    );
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the first --help argument prints usage without a workspace', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-help-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const output = [];
  const exitSignal = new Error('command exited');

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    process.argv = ['node', 'atris', 'publish', '--help'];
    console.log = (...parts) => output.push(parts.join(' '));
    console.error = () => {};
    process.exit = () => { throw exitSignal; };

    const { publishAtris } = require('../commands/publish');
    try {
      await publishAtris();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }

    assert.ok(output.some((line) => /\busage\b/i.test(line)), 'help should print usage');
  } finally {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

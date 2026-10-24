require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('--yes alone authorizes writing the workspace documents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-confirm-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedExit = process.exit;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'sync', '--yes'];
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    fs.mkdirSync(path.join(root, 'atris'));
    const { syncAtris } = require('../commands/sync');

    syncAtris();

    assert.equal(lines.some(line => line.includes('Plan only.')), false,
      '--yes alone must authorize changes rather than leave a preview');
    assert.equal(fs.existsSync(path.join(root, 'atris', 'atris.md')), true,
      '--yes alone must write the canonical workspace document');
  } finally {
    console.log = savedLog;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

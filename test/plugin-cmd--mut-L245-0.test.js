require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('build writes the package to the requested output filename', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-output-'));
  const previousCwd = process.cwd();
  const savedEnv = Object.fromEntries(
    ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'PATH'].map(key => [key, process.env[key]])
  );
  t.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = root;
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  process.env.PATH = '/usr/bin:/bin';
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'atris', 'skills'), { recursive: true });
  process.chdir(workspace);
  const lines = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
  }
  t.mock.method(process, 'exit', code => {
    throw new Error(`command exited with ${code}`);
  });

  pluginCommand('build', '--output=chosen.plugin');

  assert.equal(fs.existsSync(path.join(workspace, 'chosen.plugin')), true);
});

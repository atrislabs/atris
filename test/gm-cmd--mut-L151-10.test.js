'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gmCommand } = require('../commands/gm');

test('inline workspace selects the folder reported by the board', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-inline-workspace-')));
  const workspace = path.join(root, 'club');
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const exitCode = process.exitCode;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    await gmCommand('--board', '--json', `--workspace=${workspace}`);
    assert.equal(JSON.parse(output.join('\n')).workspace_root, workspace);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.exitCode = exitCode;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});

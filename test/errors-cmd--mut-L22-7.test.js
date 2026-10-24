const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('account errors direct a signed-out user to login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-signed-out-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const argv = process.argv;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  const stopped = new Error('command stopped');
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  api.apiRequestJson = async () => { throw new Error('unexpected API call'); };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = dir;
    process.env.TERM_SESSION_ID = 'signed-out-test';
    process.chdir(dir);
    process.argv = [process.execPath, 'atris', 'errors', '--account'];
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = () => { throw stopped; };
    const { errorsCommand } = require('../commands/errors');
    try {
      await errorsCommand();
    } catch {
      // The login instruction must be printed even when the command stops.
    }
    assert.match(output.join('\n'), /login/i);
  } finally {
    api.apiRequestJson = request;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(cwd);
    process.argv = argv;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});

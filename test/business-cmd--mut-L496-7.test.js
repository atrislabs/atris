'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('create uses the requested relative workspace root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-root-flag-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const previousExitCode = process.exitCode;
  const api = require('../utils/api');
  const previousRequest = api.apiRequestJson;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token', provider: 'test', saved_at: '2026-01-15T00:00:00.000Z',
    }));
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    api.apiRequestJson = async () => ({
      ok: true,
      data: { id: 'biz-root', workspace_id: 'ws-root', name: 'Root Shop', slug: 'root-shop' },
    });
    const { businessCommand } = require('../commands/business');
    await businessCommand('create', 'Root Shop', '--root', 'chosen', '--force');
    assert.equal(fs.existsSync(path.join(home, 'chosen', 'root-shop', '.atris', 'business.json')), true,
      'the requested root must contain the new workspace binding');
  } finally {
    api.apiRequestJson = previousRequest;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.exitCode = previousExitCode;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});

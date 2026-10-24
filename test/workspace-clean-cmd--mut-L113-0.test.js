'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a missing remote business is reported as not found', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-missing-business-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  let api;
  let savedRequest;
  const errors = [];
  const exitSignal = new Error('command exited');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme' },
    }));
    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async () => ({ ok: false, status: 404, error: 'Resource unavailable' });
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'acme'];
    console.log = () => {};
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = () => { throw exitSignal; };
    try {
      await cleanWorkspace();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.match(errors.join('\n'), /not found/i);
  } finally {
    if (api) api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

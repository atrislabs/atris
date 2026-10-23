'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('a forbidden workspace request reports the access problem', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-denied-clean-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const previousRequest = api.apiRequestJson;
  const output = [];
  const exit = new Error('command exited');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme' },
    }));
    api.apiRequestJson = async () => ({
      ok: false, status: 403, data: { detail: 'Membership required' },
      text: '{"detail":"Membership required"}', error: 'Membership required',
    });
    const { cleanWorkspace } = require('../commands/workspace-clean');
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = () => { throw exit; };
    process.argv = ['node', 'atris', 'clean-workspace', 'acme'];
    try {
      await cleanWorkspace();
    } catch (error) {
      if (error !== exit) throw error;
    }
    assert.match(output.join('\n'), /access denied/i);
  } finally {
    api.apiRequestJson = previousRequest;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.argv = previousArgv;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});

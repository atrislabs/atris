'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('shows the server explanation when loading workspace files fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clean-error-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  const output = [];
  const exitSignal = new Error('command exited');
  const exits = [];
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
      ok: false,
      status: 500,
      data: { detail: 'Workspace storage is unavailable' },
      text: '{"detail":"Workspace storage is unavailable"}',
      error: 'Workspace storage is unavailable',
    });
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'acme'];
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => {
      exits.push(code);
      throw exitSignal;
    };
    try {
      await cleanWorkspace();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.match(output.join('\n'), /Workspace storage is unavailable/);
    assert.deepEqual(exits, [1]);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

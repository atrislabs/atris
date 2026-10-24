'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('cleanup report identifies the cached business by its display name', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clean-name-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  let api;
  let savedRequest;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme Studio', slug: 'acme' },
    }));
    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async () => ({
      ok: true,
      data: { files: [{ path: 'notes.md', size: 128 }] },
    });
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'acme'];
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    await cleanWorkspace();
    const reportTitle = output.find(line => line.includes('Workspace:')) || '';
    assert.match(reportTitle, /Acme Studio/);
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

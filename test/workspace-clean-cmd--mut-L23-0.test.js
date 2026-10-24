'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('reports the total size of nonempty workspace files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-bytes-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris/credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(home, '.atris/businesses.json'), JSON.stringify({ acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme' } }));
    api.apiRequestJson = async () => ({ ok: true, status: 200, data: { files: [
      { path: '/notes.md', hash: 'same-content', size: 1536 },
    ] } });
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'acme'];
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await cleanWorkspace();
    assert.match(output.find(line => line.includes('Total size:')) || '', /1\.5\s+KB/);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

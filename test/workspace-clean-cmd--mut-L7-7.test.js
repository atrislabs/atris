'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('cleanup preserves a nonempty document while deleting an empty file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clean-document-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  const deletions = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme' },
    }));
    api.apiRequestJson = async (url, options) => {
      if (url.endsWith('/snapshot?include_content=false')) {
        return { ok: true, data: { files: [
          { path: 'notes.md', size: 128 },
          { path: 'empty.txt', size: 0 },
        ] } };
      }
      if (url.endsWith('/sync') && options.method === 'POST') {
        deletions.push(...options.body.files.map(file => file.path));
        return { ok: true, data: {} };
      }
      throw new Error('unexpected request');
    };
    const { cleanWorkspace } = require('../commands/workspace-clean');
    process.argv = ['node', 'atris', 'clean-workspace', 'acme', '--yes'];
    console.log = () => {};
    console.error = () => {};
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await cleanWorkspace();
    assert.equal(deletions.includes('notes.md'), false);
    assert.equal(deletions.includes('empty.txt'), true);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('pull replaces conflicting local text with an empty cloud file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-pull-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const savedWrite = process.stdout.write;
  let api;
  let savedRequest;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    const output = path.join(root, 'workspace');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'empty.txt'), 'old local text');
    process.argv = [process.execPath, 'atris', 'pull', 'sample', '--into', output, '--no-manifest'];
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token', saved_at: '2025-01-01T00:00:00.000Z',
    }));
    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async (url) => {
      if (url === '/business/') return { ok: true, data: [
        { id: 'business-1', workspace_id: 'workspace-1', slug: 'sample', name: 'Sample' },
      ] };
      if (url === '/business/business-1/workspaces/workspace-1/snapshot?include_content=true') {
        return { ok: true, data: { files: [{ path: '/empty.txt', content: '' }] } };
      }
      if (url.endsWith('/git/head')) return { ok: true, data: { commit: null } };
      if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
      throw new Error(`unexpected request ${url}`);
    };
    const { pullAtris } = require('../commands/pull');
    await pullAtris();
    assert.equal(fs.readFileSync(path.join(output, 'empty.txt'), 'utf8'), '');
  } finally {
    if (api) api.apiRequestJson = savedRequest;
    process.chdir(savedCwd);
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
    process.stdout.write = savedWrite;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

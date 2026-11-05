'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const scenario of ['read error', 'directory error', 'binary file', 'symbolic link']) test(`pull preserves an existing local destination: ${scenario}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-unreadable-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const savedWrite = process.stdout.write;
  const savedRead = fs.readFileSync;
  const savedReaddir = fs.readdirSync;
  let api;
  let savedRequest;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    const output = path.join(root, 'workspace');
    const local = path.join(output, 'notes.md');
    fs.mkdirSync(output);
    const original = scenario === 'binary file' ? Buffer.from([0, 1, 2]) : Buffer.from('important local content');
    const target = path.join(root, 'link-target');
    if (scenario === 'symbolic link') {
      fs.writeFileSync(target, original);
      fs.symlinkSync(target, local);
    } else {
      fs.writeFileSync(local, original);
    }
    process.argv = [process.execPath, 'atris', 'pull', 'sample', '--into', output, '--no-manifest', '--keep-local'];
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = () => {};
    console.error = () => {};
    process.stdout.write = () => true;
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async (url) => {
      if (url === '/business/') return { ok: true, data: [{ id: 'business-1', workspace_id: 'workspace-1', slug: 'sample', name: 'Sample' }] };
      if (url === '/business/business-1/workspaces/workspace-1/snapshot?include_content=true') return { ok: true, data: { files: [{ path: '/notes.md', content: 'cloud content' }] } };
      if (url.endsWith('/git/head')) return { ok: true, data: { commit: null } };
      if (url === '/atris-sync/telemetry') return { ok: true, data: {} };
      throw new Error(`unexpected request ${url}`);
    };
    const { pullAtris } = require('../commands/pull');
    fs.readFileSync = function(file, ...args) {
      if (scenario === 'read error' && file === local) throw Object.assign(new Error('simulated read failure'), { code: 'EIO' });
      return savedRead.call(fs, file, ...args);
    };
    fs.readdirSync = function(dir, ...args) {
      if (scenario === 'directory error' && dir === output) throw Object.assign(new Error('simulated directory failure'), { code: 'EIO' });
      return savedReaddir.call(fs, dir, ...args);
    };
    await assert.rejects(pullAtris(), /cannot safely (scan|pull)/i);
    fs.readFileSync = savedRead;
    fs.readdirSync = savedReaddir;
    assert.deepEqual(fs.readFileSync(local), original);
  } finally {
    fs.readFileSync = savedRead;
    fs.readdirSync = savedReaddir;
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

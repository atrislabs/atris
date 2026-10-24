require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a running computer without an endpoint must be woken before upload', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'push-readiness-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const argv = process.argv;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const stop = new Error('stop before waiting or uploading');
  let wakeRequested = false;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.ATRIS_NO_INTERACTIVE = '1';
    const workspace = path.join(home, 'workspace');
    fs.mkdirSync(workspace);
    process.chdir(workspace);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.mkdirSync(path.join(workspace, 'atris'));
    fs.writeFileSync(path.join(workspace, 'atris', 'now.md'), 'ready to sync\n');
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    process.argv = [process.execPath, 'atris', 'push', 'acme', '--from', workspace, '--auto-wake', '--yes'];
    api.apiRequestJson = async (pathname) => {
      if (pathname === '/business/') return { ok: true, status: 200, data: [
        { id: 'biz-1', slug: 'acme', name: 'Acme', workspace_id: 'ws-1' },
      ] };
      if (pathname === '/business/biz-1/ai-computer/status') {
        return { ok: true, status: 200, data: { status: 'running', endpoint: null } };
      }
      if (pathname === '/business/biz-1/ai-computer/wake') wakeRequested = true;
      throw stop;
    };
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(process, 'exit', () => { throw stop; });
    const { pushAtris } = require('../commands/push');
    try { await pushAtris(); } catch (error) { if (error !== stop) throw error; }
    assert.equal(wakeRequested, true);
  } finally {
    t.mock.restoreAll();
    api.apiRequestJson = request;
    process.argv = argv;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});

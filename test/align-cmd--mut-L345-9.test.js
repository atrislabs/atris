const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('hard alignment preserves a protected cloud-only directory', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-protected-entry-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const savedWrite = process.stdout.write;
  let api;
  let savedRequest;
  const deletions = [];
  const logs = [];
  let failure;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    const workspace = path.join(home, 'workspace');
    fs.mkdirSync(path.join(workspace, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.atris', 'business.json'), JSON.stringify({ slug: 'sample' }));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    process.chdir(workspace);
    process.argv = ['node', 'atris', 'align', 'sample', '--fix', '--hard'];
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    process.stdout.write = () => true;

    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async (route, options) => {
      if (route === '/business/' && options.method === 'GET') {
        return { ok: true, data: [{ id: 'biz', workspace_id: 'ws', slug: 'sample', name: 'Sample' }] };
      }
      if (route === '/business/biz/ai-computer/status' && options.method === 'GET') {
        return { ok: true, data: { status: 'running', endpoint: 'https://unused.invalid' } };
      }
      if (route === '/business/biz/workspaces/ws/files' && options.method === 'GET') {
        return { ok: true, data: { files: [{ name: 'workspace', type: 'directory' }] } };
      }
      if (route === '/business/biz/workspaces/ws/file?path=%2Fworkspace' && options.method === 'DELETE') {
        deletions.push('workspace');
        return { ok: true };
      }
      throw new Error(`unexpected API request: ${options.method} ${route}`);
    };
    const { alignAtris } = require('../commands/align');
    try {
      await alignAtris();
    } catch (error) {
      failure = error;
    }
    assert.equal(deletions.includes('workspace'), false, 'the protected workspace directory must not be deleted');
    if (failure) throw failure;
  } finally {
    if (api) api.apiRequestJson = savedRequest;
    process.chdir(savedCwd);
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
    process.stdout.write = savedWrite;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});

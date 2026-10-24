require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('dry run excludes private hidden folders from local files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-hidden-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  const previousExit = process.exit;
  const previousLog = console.log;
  const previousError = console.error;
  const output = [];
  const exit = new Error('command exit');
  process.env.HOME = home;
  process.chdir(home);
  fs.mkdirSync(path.join(home, '.atris'));
  fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }));
  fs.mkdirSync(path.join(home, '.private'));
  fs.writeFileSync(path.join(home, '.private', 'secret.md'), 'private note');
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token', refresh_token: null, email: null, user_id: null, provider: null, saved_at: '2025-01-01T00:00:00.000Z' }));
  const api = require('../utils/api');
  const previousRequest = api.apiRequestJson;
  api.apiRequestJson = async (route) => {
    if (route === '/business/') {
      return { ok: true, data: [{ id: 'example-id', workspace_id: 'ws-example', slug: 'example-co' }] };
    }
    if (route.endsWith('/ai-computer/status')) {
      return { ok: true, data: { endpoint: 'https://computer.invalid', status: 'running' } };
    }
    if (route.includes('/snapshot?') || route.endsWith('/files')) {
      return { ok: true, data: { files: [] } };
    }
    if (route.includes('validate')) return { ok: true, data: { valid: true } };
    throw new Error(`unexpected API request: ${route}`);
  };
  fs.writeFileSync(path.join(home, 'visible.md'), 'shared note');
  process.argv = ['node', 'atris', 'align', '--dry-run'];
  console.log = console.error = (...args) => output.push(args.join(' '));
  process.exit = () => { throw exit; };
  try {
    const { alignAtris } = require('../commands/align');
    try { await alignAtris(); } catch (error) { if (error !== exit) throw error; }
  } finally {
    api.apiRequestJson = previousRequest;
    process.chdir(previousCwd);
    process.argv = previousArgv;
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.match(output.join('\n'), /Only local:\s+1\b/);
});

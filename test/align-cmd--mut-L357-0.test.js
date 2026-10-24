require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('force-push identifies a cloud-only directory as a directory', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'align-file-kind-'));
  const savedHome = process.env.HOME;
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  process.env.HOME = home;
  const auth = require('../utils/auth');
  const api = require('../utils/api');
  const savedLoad = auth.loadCredentials;
  const savedEnsure = auth.ensureValidCredentials;
  const savedRequest = api.apiRequestJson;
  const savedHttp = api.httpRequest;
  const savedWrite = process.stdout.write;
  const output = [];
  const stopped = new Error('command exited');
  try {
    fs.mkdirSync(path.join(home, '.atris'));
    fs.mkdirSync(path.join(home, 'atris'));
    fs.writeFileSync(path.join(home, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }));

    auth.loadCredentials = () => ({ token: 'fixture-token' });
    auth.ensureValidCredentials = async () => ({ token: 'fixture-token' });
    api.httpRequest = async () => ({ status: 200, statusCode: 200, ok: true, data: {} });
    api.apiRequestJson = async (url) => {
      if (url === '/business/') return { ok: true, status: 200, data: [{ id: 'business', slug: 'example-co', workspace_id: 'workspace' }] };
      if (url.endsWith('/ai-computer/status')) return { ok: true, status: 200, data: { status: 'running', endpoint: 'https://unused.invalid' } };
      if (url.endsWith('/files')) return { ok: true, status: 200, data: { files: [{ name: 'obsolete', path: 'obsolete', type: 'dir' }] } };
      if (url.includes('/file?path=')) return { ok: true, status: 200, data: {} };
      throw new Error('unexpected request: ' + url);
    };
    const { alignAtris } = require('../commands/align');
    process.chdir(home);
    process.argv = ['node', 'atris', 'align', 'example-co', '--fix', '--hard', '--from', 'local'];
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.stdout.write = function (chunk, ...args) {
      if (typeof chunk !== 'string') return savedWrite.call(this, chunk, ...args);
      output.push(chunk);
      return true;
    };
    process.exit = () => { throw stopped; };
    try {
      await alignAtris();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.match(output.join('\n'), /obsolete[^\n]*\(dir\)/);
  } finally {
    process.chdir(savedCwd);
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
    auth.loadCredentials = savedLoad;
    auth.ensureValidCredentials = savedEnsure;
    api.apiRequestJson = savedRequest;
    api.httpRequest = savedHttp;
    process.stdout.write = savedWrite;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

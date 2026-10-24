require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('running a shell command prints the stdout returned by the terminal', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-terminal-output-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedExit = process.exit;
  const savedWrite = process.stdout.write;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  let output = '';
  let terminalCalled = false;

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.ATRIS_NO_INTERACTIVE = '1';
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      provider: 'test',
    }));

    api.apiRequestJson = async (pathname, options) => {
      if (pathname === '/business/') {
        return { ok: true, status: 200, data: [{ id: 'biz-1', slug: 'acme', name: 'Acme' }] };
      }
      if (pathname === '/business/biz-1/ai-computer/status') {
        return { ok: true, status: 200, data: {
          status: 'running',
          endpoint: 'https://runner.example',
          attached_workspace_id: 'ws-new',
        } };
      }
      if (pathname === '/business/biz-1/workspaces/ws-new/terminal') {
        assert.equal(options.method, 'POST');
        assert.equal(options.body.command, 'printf terminal-output-ok');
        terminalCalled = true;
        return { ok: true, status: 200, data: {
          stdout: 'terminal-output-ok', stderr: '', exit_code: 0,
        } };
      }
      throw new Error(`Unexpected API request: ${pathname}`);
    };
    const { runComputer } = require('../commands/computer');
    process.stdout.write = function (chunk, encoding, callback) {
      output += String(chunk);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) done();
      return true;
    };
    process.exit = (code) => { throw new Error(`Unexpected exit: ${code}`); };

    await runComputer(['run', 'printf terminal-output-ok', '--business', 'acme', '--workspace', 'ws-new']);

    assert.equal(terminalCalled, true);
    assert.match(output, /terminal-output-ok/);
  } finally {
    process.stdout.write = savedWrite;
    process.exit = savedExit;
    api.apiRequestJson = savedRequest;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

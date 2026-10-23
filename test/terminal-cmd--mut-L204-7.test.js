'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('successful remote command prints its stdout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-output-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedExit = process.exit;
  const savedLog = console.log;
  const savedError = console.error;
  const savedWrite = process.stdout.write;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  const output = [];
  const exitSignal = new Error('captured exit');

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));
    api.apiRequestJson = async (endpoint) => { if (endpoint === '/business/') return { ok: true, data: [{ slug: 'example-co', id: 'example-id', workspace_id: 'workspace-id', name: 'example-co' }] }; return ({
      ok: true,
      status: 200,
      data: { valid: true, status: 'running', endpoint: 'https://computer.invalid', stdout: 'remote-output-marker\n', stderr: '', exit_code: 0 },
    }); };
    const { terminalAtris } = require('../commands/terminal');
    process.argv = ['node', 'atris', 'terminal', '--account', 'example-co', 'echo remote-output-marker'];
    process.exit = () => { throw exitSignal; };
    console.log = (...parts) => output.push(parts.join(' '));
    console.error = () => {};
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    try {
      await terminalAtris();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.equal(output.join('\n').includes('remote-output-marker'), true);
  } finally {
    api.apiRequestJson = savedRequest;
    process.argv = savedArgv;
    process.exit = savedExit;
    console.log = savedLog;
    console.error = savedError;
    process.stdout.write = savedWrite;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

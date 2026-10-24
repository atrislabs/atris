'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('status displays the business returned by the remote directory when it is not cached', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-remote-business-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];
  const stopped = new Error('command stopped');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.env.TERM_SESSION_ID = 'remote-business-test';
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'sandbox-token', provider: null, email: 'test@example.com',
    }));
    api.apiRequestJson = async (url) => {
      if (url === '/business/') return { ok: true, data: [
        { id: 'biz-remote', workspace_id: 'ws-remote', slug: 'orchard', name: 'Orchard Studio' },
      ] };
      if (url === '/business/biz-remote/workspaces/ws-remote/snapshot?include_content=true') {
        return { ok: true, data: { files: [] } };
      }
      throw new Error('unexpected API route');
    };
    const { businessStatus } = require('../commands/context-sync');
    console.log = (...args) => lines.push(args.join(' '));
    console.error = () => {};
    process.exit = () => { throw stopped; };
    try {
      await businessStatus('orchard');
    } catch (err) {
      if (err !== stopped) throw err;
    }
    assert.ok(lines.some(line => line.includes('Orchard Studio')));
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

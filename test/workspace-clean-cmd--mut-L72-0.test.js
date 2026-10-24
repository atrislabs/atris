'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an uncached unknown slug rejects an unrelated business', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unknown-business-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const api = require('../utils/api');
  const savedRequest = api.apiRequestJson;
  const errors = [];
  const exit = new Error('command exited');

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'),
      JSON.stringify({ token: 'test-token' }));
    process.argv = ['node', 'atris', 'clean-workspace', 'missing-shop'];
    console.log = () => {};
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = () => { throw exit; };
    api.apiRequestJson = async (endpoint) => {
      if (endpoint !== '/business/') throw new Error('unexpected request');
      return { ok: true, data: [
        { id: 'other-id', slug: 'other-shop', name: 'Other Shop', workspace_id: null },
      ] };
    };
    const { cleanWorkspace } = require('../commands/workspace-clean');
    try {
      await cleanWorkspace();
    } catch (error) {
      if (error !== exit) throw error;
    }
    assert.match(errors.join('\n'), /missing-shop.*not found/i);
  } finally {
    api.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.argv = savedArgv;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

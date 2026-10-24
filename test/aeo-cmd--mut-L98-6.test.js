'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('initializing a stopped computer requests a wake even when status succeeds', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-aeo-stopped-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  const auth = require('../utils/auth');
  const api = require('../utils/api');
  const originalLoad = auth.loadCredentials;
  const originalRequest = api.apiRequestJson;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const stopped = new Error('request boundary reached');
  let wakeRequested = false;
  auth.loadCredentials = () => ({ token: 'test-token' });
  api.apiRequestJson = async (route, options) => {
    if (route === '/business/') {
      return { ok: true, data: [{ id: 'business-1', slug: 'example', workspace_id: 'workspace-1' }] };
    }
    if (route === '/business/business-1/ai-computer/status') {
      return { ok: true, data: { status: 'stopped', endpoint: null } };
    }
    if (route === '/business/business-1/ai-computer/wake' && options.method === 'POST') {
      wakeRequested = true;
    }
    throw stopped;
  };
  console.log = () => {};
  console.error = () => {};
  process.exit = () => { throw stopped; };
  try {
    const { run } = require('../commands/aeo');
    try {
      await run(['init', '--workspace', 'example']);
    } catch (error) {
      if (error !== stopped) throw error;
    }
    assert.equal(wakeRequested, true);
  } finally {
    auth.loadCredentials = originalLoad;
    api.apiRequestJson = originalRequest;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

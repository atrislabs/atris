'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('join explains that failed account creation leaves the invite unclaimed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-join-signup-failure-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const errors = [];
  const requests = [];
  const exitSignal = new Error('intercepted exit');
  let exitCode;
  let apiModule;
  let savedRequest;

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    apiModule = require('../utils/api');
    savedRequest = apiModule.apiRequestJson;
    apiModule.apiRequestJson = async (pathname) => {
      requests.push(pathname);
      if (pathname === '/invites/ABC123') {
        return { status: 200, data: { can_claim: true, inviter_display_name: 'Ada' } };
      }
      throw new Error(`unexpected request: ${pathname}`);
    };
    console.log = () => {};
    console.error = (...parts) => errors.push(parts.join(' '));
    process.exit = (code) => { exitCode = code; throw exitSignal; };

    const { socialCommand } = require('../commands/social');
    try {
      // A person can supply a handle containing punctuation, which signup rejects.
      await socialCommand(['join', 'ABC123', '--handle', 'bad-handle']);
    } catch (error) {
      if (error !== exitSignal) throw error;
    }

    assert.match(errors.join('\n'), /Account creation failed, so the invite was not claimed/);
    assert.match(errors.join('\n'), /Invalid handle/);
    assert.equal(exitCode, 1);
    assert.equal(requests.includes('/invites/ABC123'), true);
    assert.equal(requests.some((pathname) => pathname.endsWith('/claim')), false);
  } finally {
    if (apiModule) apiModule.apiRequestJson = savedRequest;
    console.log = savedLog;
    console.error = savedError;
    process.exit = savedExit;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});

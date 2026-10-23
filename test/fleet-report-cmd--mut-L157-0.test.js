'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('leaderboard shows empty state when no scoreboards exist', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-test-'));
  const original = {
    argv: process.argv,
    cwd: process.cwd(),
    env: { ...process.env },
    exit: process.exit,
    exitCode: process.exitCode,
    log: console.log,
    error: console.error,
  };

  const authPath = require.resolve('../utils/auth');
  const apiPath = require.resolve('../utils/api');
  const origAuth = require.cache[authPath];
  const origApi = require.cache[apiPath];

  const logs = [];
  const errors = [];
  const stopped = new Error('intercepted process.exit');
  let exit;

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    process.argv = ['node', 'atris', 'cmd', '--leaderboard', '--account'];
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    process.exit = (code) => {
      exit = code;
      throw stopped;
    };

    require.cache[authPath] = {
      id: authPath,
      filename: authPath,
      loaded: true,
      exports: { loadCredentials: () => ({ token: 'mock-token' }) },
    };

    require.cache[apiPath] = {
      id: apiPath,
      filename: apiPath,
      loaded: true,
      exports: {
        apiRequestJson: async (route) => {
          if (route === '/business/') {
            return { ok: true, data: [] };
          }
          return { ok: true, data: {} };
        },
      },
    };

    for (const key of Object.keys(require.cache)) {
      if (require.cache[key] && require.cache[key].exports && require.cache[key].exports.fleetReport) {
        delete require.cache[key];
      }
    }

    const { fleetReport } = require('../commands/fleet-report');

    try {
      await fleetReport();
    } catch (err) {
      if (err !== stopped) throw err;
    }

    assert.ok(logs.some((line) => line.includes('(no scoreboards yet)')));
  } finally {
    for (const key of Object.keys(require.cache)) {
      if (require.cache[key] && require.cache[key].exports && require.cache[key].exports.fleetReport) {
        delete require.cache[key];
      }
    }
    if (origAuth) require.cache[authPath] = origAuth;
    else delete require.cache[authPath];
    if (origApi) require.cache[apiPath] = origApi;
    else delete require.cache[apiPath];

    process.chdir(original.cwd);
    process.argv = original.argv;
    process.exit = original.exit;
    process.exitCode = original.exitCode;
    console.log = original.log;
    console.error = original.error;
    for (const key of Object.keys(process.env)) {
      if (!(key in original.env)) delete process.env[key];
    }
    Object.assign(process.env, original.env);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

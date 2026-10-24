'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('audit keeps a non-active single-member business with an app inactive', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-audit-activity-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  let api;
  let previousRequest;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'audit-test-token',
      provider: 'test',
    }));

    api = require('../utils/api');
    previousRequest = api.apiRequestJson;
    api.apiRequestJson = async (endpoint) => {
      if (endpoint !== '/business/') throw new Error('unexpected API endpoint');
      return {
        ok: true,
        data: [{ name: 'Solo Studio', status: 'inactive', member_count: 1, app_count: 1 }],
      };
    };
    const { businessCommand } = require('../commands/business');
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    await businessCommand('audit');

    const row = lines.find(line => line.includes('Solo Studio')) || '';
    assert.match(row, /\binactive\s*$/);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    if (api) api.apiRequestJson = previousRequest;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});

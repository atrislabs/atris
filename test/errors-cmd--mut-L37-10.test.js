const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('inline hours reaches the account request as the supplied number', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-inline-hours-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const argv = process.argv;
  const log = console.log;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const calls = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = () => {};
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    api.apiRequestJson = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, data: { groups: [], total_events: 0, user: { role: 'admin' } } };
    };
    require('../utils/auth').saveCredentials('test-access-token', null, 'admin@example.com', 'test-admin');
    const { errorsCommand } = require('../commands/errors');
    process.argv = [process.execPath, 'atris', 'errors', '--account', '--hours=72', '--json'];
    await errorsCommand();
    assert.ok(calls.some(([endpoint]) => /[?&]hours=72(?:&|$)/.test(endpoint)));
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    process.exit = exit;
    process.argv = argv;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

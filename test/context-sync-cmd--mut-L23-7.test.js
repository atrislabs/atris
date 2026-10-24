'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');
const savedRequest = api.apiRequestJson;
api.apiRequestJson = async () => ({ ok: true, data: { files: [] } });
const { businessStatus } = require('../commands/context-sync');
api.apiRequestJson = savedRequest;

test('status preserves the registered business display name', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-display-name-'));
  const savedHome = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const authKeys = ['ATRIS_TOKEN', 'ATRIS_PROFILE', 'ATRIS_AGENT_TOKEN_FILE', 'ATRIS_CLIENT_ID', 'ATRIS_CLIENT_SECRET_FILE'];
  const savedAuth = authKeys.map(key => process.env[key]);
  const lines = [];
  try {
    process.env.HOME = home;
    for (const key of authKeys) delete process.env[key];
    process.chdir(home);
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({ token: 'sandbox-token', provider: null, email: 'test@example.com' }));
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({ acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme Workshop', slug: 'acme' } }));
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await businessStatus('acme');
    assert.ok(lines.some(line => line.includes('Acme Workshop')));
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    authKeys.forEach((key, index) => {
      if (savedAuth[index] === undefined) delete process.env[key];
      else process.env[key] = savedAuth[index];
    });
  }
});

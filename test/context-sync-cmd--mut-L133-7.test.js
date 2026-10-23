'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('status reports no conflicts when only the computer has a new file', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-one-side-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const api = require('../utils/api');
  const request = api.apiRequestJson;
  const lines = [];

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = sandbox;
    process.chdir(sandbox);
    const state = path.join(sandbox, '.atris');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'credentials.json'), JSON.stringify({
      token: 'sandbox-token', provider: null, email: 'test@example.com',
    }));
    fs.writeFileSync(path.join(state, 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme' },
    }));
    fs.mkdirSync(path.join(sandbox, 'acme'));
    api.apiRequestJson = async () => ({
      ok: true, status: 200,
      data: { files: [{ path: '/notes.md', content: 'A new remote note.\n' }] },
    });
    const { businessStatus } = require('../commands/context-sync');
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    await businessStatus('acme');

    assert.ok(lines.some(line => /conflicts:.*\(none\)/i.test(line)),
      'a one-sided remote addition should explicitly report no conflicts');
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

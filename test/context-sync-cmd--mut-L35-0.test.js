'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('status selects the requested remote slug ahead of unrelated businesses', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-slug-selection-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = sandbox;
    process.chdir(sandbox);
    fs.mkdirSync(path.join(sandbox, '.atris'));
    fs.writeFileSync(path.join(sandbox, '.atris', 'credentials.json'), JSON.stringify({
      token: 'sandbox-token', provider: null, email: 'test@example.com',
    }));
    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async (url) => {
      if (url === '/business/') return { ok: true, status: 200, data: [
        { id: 'other-id', workspace_id: 'other-workspace', slug: 'other', name: 'Other Company' },
        { id: 'chosen-id', workspace_id: 'chosen-workspace', slug: 'chosen', name: 'Requested Company' },
      ] };
      return { ok: true, status: 200, data: { files: [] } };
    });
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
    t.mock.method(process, 'exit', code => { throw new Error(`unexpected exit ${code}`); });
    const { businessStatus } = require('../commands/context-sync');
    await businessStatus('chosen');
    assert.ok(lines.some(line => line.includes('Requested Company')));
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

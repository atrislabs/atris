'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an unchanged workspace reports up to date without a conflicts section', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unchanged-status-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const lines = [];

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
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
    const local = path.join(sandbox, 'acme');
    fs.mkdirSync(local);
    const content = 'a shared project note\n';
    fs.writeFileSync(path.join(local, 'note.md'), content);
    const { saveManifest, computeLocalHashes } = require('../lib/manifest');
    saveManifest('acme', { last_sync: null, files: computeLocalHashes(local) });

    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async () => ({
      ok: true, data: { files: [{ path: '/note.md', content }] },
    }));
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    t.mock.method(console, 'error', (...args) => {
      assert.fail(`unexpected command error: ${args.join(' ')}`);
    });
    t.mock.method(process, 'exit', (code) => {
      throw new Error(`unexpected exit: ${code}`);
    });
    const { businessStatus } = require('../commands/context-sync');
    await businessStatus('acme');

    const output = lines.join('\n');
    assert.match(output, /Everything up to date\./);
    assert.doesNotMatch(output, /Conflicts:/i,
      'an unchanged workspace should not display a conflicts section');
  } finally {
    t.mock.restoreAll();
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});

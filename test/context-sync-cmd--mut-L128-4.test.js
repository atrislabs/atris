'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('status explicitly reports no conflicts for a new local note', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-conflicts-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  let api;
  let savedRequest;
  const lines = [];

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = sandbox;
    process.chdir(sandbox);
    fs.mkdirSync(path.join(sandbox, '.atris'));
    fs.writeFileSync(path.join(sandbox, '.atris', 'credentials.json'), JSON.stringify({
      token: 'sandbox-token', provider: null, email: 'test@example.com',
    }));
    fs.writeFileSync(path.join(sandbox, '.atris', 'businesses.json'), JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme' },
    }));
    fs.mkdirSync(path.join(sandbox, 'acme'));
    fs.writeFileSync(path.join(sandbox, 'acme', 'note.md'), 'A new local note.\n');

    api = require('../utils/api');
    savedRequest = api.apiRequestJson;
    api.apiRequestJson = async (endpoint) => {
      assert.equal(endpoint, '/business/biz-1/workspaces/ws-1/snapshot?include_content=true');
      return { ok: true, status: 200, data: { files: [] } };
    };
    const { businessStatus } = require('../commands/context-sync');
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    await businessStatus('acme');

    assert.match(lines.join('\n'), /note\.md/);
    assert.ok(lines.some((line) => /Conflicts:\s*\(none\)/i.test(line)),
      'a conflict-free local change should explicitly report conflicts as none');
  } finally {
    if (api) api.apiRequestJson = savedRequest;
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

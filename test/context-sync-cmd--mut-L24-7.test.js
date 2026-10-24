'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('diff uses the saved business slug to find the sync baseline', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-conflicts-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedError = console.error;
  const savedExit = process.exit;
  const savedArgv = process.argv;
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
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme-studio' },
    }));
    fs.mkdirSync(path.join(sandbox, 'acme'));
    fs.writeFileSync(path.join(sandbox, 'acme', 'note.md'), 'A new local note.\n');

    const { saveManifest, computeLocalHashes } = require('../lib/manifest');
    saveManifest('acme-studio', {
      last_sync: '2025-01-01T00:00:00.000Z',
      files: computeLocalHashes(path.join(sandbox, 'acme')),
    });
    fs.writeFileSync(path.join(sandbox, 'acme', 'note.md'), 'An updated local note.\n');
    process.argv = ['node', 'atris', 'diff', 'acme'];
    const { businessDiff } = require('../commands/context-sync');
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    await businessDiff('acme');

    assert.match(lines.join('\n'), /modified/);
  } finally {
    process.argv = savedArgv;
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

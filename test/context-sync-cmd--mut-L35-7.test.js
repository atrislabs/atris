'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

let apiResponse = async () => ({
  ok: true,
  data: [
    {
      id: 'biz-1',
      workspace_id: 'ws-1',
      slug: 'acme-corp',
      name: 'Acme Corporation',
    },
  ],
});

const origApi = api.apiRequestJson;
api.apiRequestJson = (...args) => apiResponse(...args);

const { businessStatus } = require('../commands/context-sync');

const AUTH_ENV = [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET_FILE',
];

test('resolves business by slug when name differs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-status-'));
  const atrisDir = path.join(tmpDir, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(
    path.join(atrisDir, 'credentials.json'),
    JSON.stringify({ token: 'test-token', provider: null, email: 'test@example.com' })
  );

  const saved = {
    home: process.env.HOME,
    exit: process.exit,
    log: console.log,
    error: console.error,
    env: Object.fromEntries(AUTH_ENV.map((k) => [k, process.env[k]])),
  };

  const logs = [];

  try {
    for (const k of AUTH_ENV) delete process.env[k];
    process.env.HOME = tmpDir;
    process.exit = (code) => {
      const err = new Error(`exit(${code})`);
      err.exitCode = code;
      throw err;
    };
    console.log = (...args) => logs.push(args.join(' '));
    console.error = () => {};

    await businessStatus('acme-corp');

    assert.ok(logs.some((line) => line.includes('Acme Corporation')));
  } finally {
    process.env.HOME = saved.home;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    api.apiRequestJson = origApi;
    for (const k of AUTH_ENV) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

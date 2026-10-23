'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

let mockApiHandler = null;
const origApiRequestJson = api.apiRequestJson;
api.apiRequestJson = async (...args) => {
  if (mockApiHandler) return mockApiHandler(...args);
  return origApiRequestJson(...args);
};

const { businessStatus } = require('../commands/context-sync');

const AUTH_ENV = [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET_FILE',
];

test('businessStatus shows remote files when present in snapshot', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-test-'));
  const home = path.join(sandbox, 'home');
  const work = path.join(sandbox, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(
    path.join(atrisDir, 'credentials.json'),
    JSON.stringify({ token: 'fake-token' })
  );
  fs.writeFileSync(
    path.join(atrisDir, 'businesses.json'),
    JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme' },
    })
  );

  mockApiHandler = async () => ({
    ok: true,
    status: 200,
    data: {
      files: [
        { path: 'notes.txt', content: 'hello world', binary: false },
      ],
    },
  });

  const saved = {
    home: process.env.HOME,
    cwd: process.cwd(),
    exit: process.exit,
    log: console.log,
    error: console.error,
    env: Object.fromEntries(AUTH_ENV.map((k) => [k, process.env[k]])),
  };

  const logs = [];
  try {
    for (const k of AUTH_ENV) delete process.env[k];
    process.env.HOME = home;
    process.chdir(work);

    process.exit = (code) => {
      throw new Error(`process.exit(${code})`);
    };
    console.log = (...args) => logs.push(args.join(' '));
    console.error = () => {};

    await businessStatus('acme');
    assert.ok(logs.some((line) => line.includes('notes.txt')));
  } finally {
    mockApiHandler = null;
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    process.chdir(saved.cwd);
    process.env.HOME = saved.home;
    for (const k of AUTH_ENV) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

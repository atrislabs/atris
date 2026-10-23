'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

// The command module binds the request function when it loads, so the stub
// must be installed first. nextReply is swapped per test.
let nextReply = { status: 200, json: {} };
const realRequest = api.apiRequestJson;
api.apiRequestJson = async () => nextReply;

const { businessStatus } = require('../commands/context-sync');

const AUTH_ENV = [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET_FILE',
];

test('a sleeping remote is reported as asleep, not as a generic failure', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-l85-'));
  const home = path.join(sandbox, 'home');
  const work = path.join(sandbox, 'work');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.atris', 'credentials.json'),
    JSON.stringify({ token: 'sandbox-token', provider: null, email: 'test@example.com' })
  );
  fs.writeFileSync(
    path.join(home, '.atris', 'businesses.json'),
    JSON.stringify({
      acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme' },
    })
  );

  const saved = {
    home: process.env.HOME,
    cwd: process.cwd(),
    exit: process.exit,
    log: console.log,
    error: console.error,
    env: Object.fromEntries(AUTH_ENV.map((k) => [k, process.env[k]])),
  };
  const out = { logs: [], errors: [] };

  try {
    for (const k of AUTH_ENV) delete process.env[k];
    process.env.HOME = home;
    process.chdir(work);
    nextReply = { status: 409, json: {} };
    process.exit = (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    };
    console.log = (...args) => out.logs.push(args.join(' '));
    console.error = (...args) => out.errors.push(args.join(' '));

    await assert.rejects(businessStatus('acme'), (err) => err.exitCode === 1);

    const said = out.logs.concat(out.errors).join('\n');
    assert.ok(said.includes('sleeping'), said);
    assert.ok(!said.includes('Failed to get remote state'), said);
  } finally {
    api.apiRequestJson = realRequest;
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

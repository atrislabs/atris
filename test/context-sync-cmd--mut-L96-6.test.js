'use strict';
require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('status excludes remote binary files from pending downloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-binary-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const request = api.apiRequestJson;
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.mkdirSync(path.join(root, 'acme'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'sandbox-token', provider: null, email: 'test@example.com' }));
    fs.writeFileSync(path.join(root, '.atris', 'businesses.json'), JSON.stringify({ acme: { business_id: 'biz-1', workspace_id: 'ws-1', name: 'Acme', slug: 'acme' } }));
    const respond = async () => {
      return { ok: true, status: 200, data: { files: [{ path: '/logo.png', binary: true, content: null }] } };
    };
    api.apiRequestJson = respond;
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`exit ${code}`); };
    const { businessStatus } = require('../commands/context-sync');
    await businessStatus('acme');
    assert.equal(lines.some(line => /up to date/i.test(line)), true);
  } finally {
    api.apiRequestJson = request;
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fence home and ATRIS_* state before loading the client module.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-l72-6-'));
const savedEnv = {};
for (const key of Object.keys(process.env)) {
  if (key === 'HOME' || key === 'USERPROFILE' || key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;

// The client binds the transport at load time, so swap in a stub first and
// delegate to a per-test implementation. No socket is ever opened.
const api = require('../utils/api');
const realHttpRequest = api.httpRequest;
let impl = async () => { throw new Error('transport stub not installed'); };
api.httpRequest = (url, options) => impl(url, options);

const { designRequest } = require('../lib/design-api');

after(() => {
  api.httpRequest = realHttpRequest;
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key === 'USERPROFILE' || key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a failed call with a json detail field surfaces that message text', async () => {
  impl = async () => ({ status: 503, body: '{"detail":"upstream offline"}' });
  const result = await designRequest('/probe', { key: 'test-key' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'upstream offline');
});

test('a failed call with a json body lacking error fields reports the raw body', async () => {
  const body = '{"unrelated":1}';
  impl = async () => ({ status: 503, body });
  const result = await designRequest('/probe', { key: 'test-key' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, body);
});

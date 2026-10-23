'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');
const originalRequest = api.apiRequestJson;
api.apiRequestJson = async (...args) => {
  if (!args[0].endsWith('/status')) throw new Error('unexpected wake request');
  return { ok: true, status: 200, data: { status: 'running', endpoint: 'https://runner.example' } };
};
const { ensureAwake } = require('../commands/terminal');
test('an already running workspace is ready', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-awake-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    api.apiRequestJson = originalRequest;
  });
  assert.equal(await ensureAwake('test-token', 'sample-co'), true);
});

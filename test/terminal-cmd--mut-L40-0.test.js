'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('an already running computer is ready without waking it again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-awake-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const request = api.apiRequestJson;
  const write = process.stdout.write;
  let wakeRequested = false;
  const endpoint = 'https://computer.example.test';
  process.env.HOME = root;
  process.chdir(root);
  process.stdout.write = () => true;
  api.apiRequestJson = async (route, options = {}) => {
    if (!options.method || options.method === 'GET') {
      return { ok: true, status: 200, data: { status: 'running', endpoint } };
    }
    wakeRequested = true;
    throw new Error('computer wake unavailable');
  };
  try {
    const { ensureAwake } = require('../commands/terminal');
    const result = await ensureAwake('test-token', 'example-co').catch(() => undefined);
    assert.equal(wakeRequested, false);
    assert.equal(result, true);
  } finally {
    api.apiRequestJson = request;
    process.stdout.write = write;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

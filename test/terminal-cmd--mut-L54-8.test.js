'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../utils/api');

test('ensureAwake returns true when computer wakes up and becomes running', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;

  const origApi = api.apiRequestJson;
  const origSetTimeout = global.setTimeout;
  const origLog = console.log;
  const origStdoutWrite = process.stdout.write;

  console.log = () => {};
  process.stdout.write = () => true;
  global.setTimeout = (fn) => setImmediate(fn);

  let statusCalls = 0;
  api.apiRequestJson = async (endpoint) => {
    if (endpoint.endsWith('/status')) {
      statusCalls++;
      if (statusCalls === 1) {
        return { ok: true, data: { status: 'stopped' } };
      }
      return { ok: true, data: { status: 'running', endpoint: 'https://example.com' } };
    }
    if (endpoint.endsWith('/wake')) {
      return { ok: true };
    }
    return { ok: false };
  };

  const { ensureAwake } = require('../commands/terminal');

  try {
    const result = await ensureAwake('mock-token', 'mock-biz');
    assert.strictEqual(result, true);
  } finally {
    console.log = origLog;
    process.stdout.write = origStdoutWrite;
    global.setTimeout = origSetTimeout;
    api.apiRequestJson = origApi;
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

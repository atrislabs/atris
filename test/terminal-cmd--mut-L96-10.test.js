'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('default remote command gives the HTTP request ten seconds of extra time', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-request-budget-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const api = require('../utils/api');
  const originalRequest = api.apiRequestJson;
  let requestTimeout;
  api.apiRequestJson = async (_endpoint, options) => {
    requestTimeout = options.timeoutMs;
    return { ok: true, data: { stdout: 'ready\n', stderr: '', exit_code: 0 } };
  };
  try {
    const { runTerminalCommand } = require('../commands/terminal');
    await runTerminalCommand('test-token', 'test-business', 'test-workspace', 'printf ready');
    assert.equal(requestTimeout, 40000);
  } finally {
    api.apiRequestJson = originalRequest;
  }
});

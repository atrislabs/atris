'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readyCommand } = require('../commands/human-missions');

test('readiness does not advertise work checks when the check service is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ready-unavailable-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  const previousError = console.error;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (line) => output.push(String(line));
    console.error = () => {};
    await readyCommand(['--json'], {
      root,
      businessId: 'business-1',
      loadCredentials: () => ({ token: 'test-token', user_id: 'user-1' }),
      log: console.log,
      error: console.error,
      setProcessExitCode: false,
      apiRequestJson: async (pathname) => {
        if (pathname === '/ai-computer/user/status') {
          return { ok: true, status: 200, data: { status: 'running', version: '1.0' } };
        }
        if (pathname === '/atris2/health') {
          return { ok: true, status: 200, data: { ready: true } };
        }
        return { ok: false, status: 503, data: { detail: 'Service unavailable' }, error: 'Service unavailable' };
      },
    });
    assert.equal(JSON.parse(output.join('\n')).can_check_work, false);
  } finally {
    process.chdir(previousCwd);
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

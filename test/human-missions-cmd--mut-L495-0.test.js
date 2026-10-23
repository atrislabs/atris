'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('missing proof tells the user to finish a mission first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-proof-missing-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const { proofCommand } = require('../commands/human-missions');
    await proofCommand(['--json'], {
      root,
      setProcessExitCode: false,
      loadCredentials: () => ({ token: 'test-token', user_id: 'user-1' }),
      apiRequestJson: async () => ({
        ok: false,
        status: 404,
        data: { detail: 'Not Found' },
        error: 'Not Found',
      }),
      log: (line) => output.push(String(line)),
      error: (line) => output.push(String(line)),
    });
    assert.match(JSON.parse(output.join('\n')).next, /finish a mission/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

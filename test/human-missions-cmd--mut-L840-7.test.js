'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('text check results retain a check supplied with only a name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-name-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  process.env.HOME = root;
  process.chdir(root);
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  try {
    const { checkCommand } = require('../commands/human-missions');
    const output = [];
    await checkCommand(['mission-prices'], {
      root,
      log: (line) => output.push(String(line)),
      error: (line) => output.push(String(line)),
      setProcessExitCode: false,
      loadCredentials: () => ({ token: 'test-token', user_id: 'user-1' }),
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          mission_id: 'mission-prices',
          result: { checks: [{ name: 'Prices unchanged', passed: true }] },
        },
      }),
    });
    assert.match(output.join('\n'), /\bunchanged\b/i);
  } finally {
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

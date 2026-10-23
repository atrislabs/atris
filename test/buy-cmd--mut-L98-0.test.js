'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a quoted purchase displays its selected options', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-buy-options-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const { buyCommand } = require('../commands/buy');
    const output = [];
    await buyCommand(['quote', '--kind', 'shop', '--query', 'cotton shirt'], {
      loadCredentials: () => ({ token: 'test-login' }),
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          status: 'quoted',
          id: 'shirt-quote',
          kind: 'shop',
          options: { size: 'large' },
        },
      }),
      now: () => 0,
      log: (line) => output.push(String(line)),
      err: () => {},
    });
    assert.match(output.join('\n'), /size[^\n]*large/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('buy status displays a completed purchase when approval is explicitly null', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-buy-null-approval-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const { buyCommand } = require('../commands/buy');
    const output = [];
    const errors = [];
    const result = await buyCommand(['status', 'ord_completed'], {
      loadCredentials: () => ({ token: 'saved-login' }),
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          id: 'ord_completed',
          kind: 'shop',
          state: 'done',
          what: 'Navy tee',
          amount_cents: 2500,
          currency: 'usd',
          approval: null,
        },
      }),
      now: () => 0,
      log: (line) => output.push(String(line)),
      err: (line) => errors.push(String(line)),
    });
    assert.match(output.join('\n'), /Navy tee/);
    assert.match(output.join('\n'), /DONE/i);
    assert.equal(result, 0, errors.join('\n'));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

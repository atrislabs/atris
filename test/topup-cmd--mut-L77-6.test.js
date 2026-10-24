'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { topupCommand } = require('../commands/topup');

test('piped checkout output does not open a browser', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-piped-checkout-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let opened = false;

  try {
    process.env.HOME = home;
    process.chdir(home);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    await topupCommand(['10'], {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async () => ({
        ok: true,
        status: 200,
        data: {
          checkout_url: 'https://checkout.stripe.com/pay/test-checkout',
          credits_to_add: 1000,
        },
      }),
      openBrowser: () => { opened = true; },
    });

    assert.strictEqual(opened, false, 'piped output must leave the browser closed');
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    if (originalTty) Object.defineProperty(process.stdout, 'isTTY', originalTty);
    else delete process.stdout.isTTY;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

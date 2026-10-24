require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('failed commands preserve the output printed before exiting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-failed-output-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { applyOp } = require('../commands/serve');
    const response = await applyOp(home, {
      type: 'bash',
      command: "printf 'partial-output'; exit 7",
    });
    assert.strictEqual(response.result.stdout, 'partial-output');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

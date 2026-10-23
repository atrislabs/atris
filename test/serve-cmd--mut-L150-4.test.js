const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('complete command output at the limit is not marked truncated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-output-limit-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const { applyOp } = require('../commands/serve');
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    const script = 'process.stdout.write("x".repeat(100000))';
    const output = await applyOp(root, {
      type: 'bash',
      command: `${quote(process.execPath)} -e ${quote(script)}`,
    });
    assert.strictEqual(output.result.truncated, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyOp } = require('../commands/serve');

test('complete stderr at the output limit is not marked truncated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stderr-limit-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const script = path.join(dir, 'diagnostic.cjs');
    fs.writeFileSync(script, "require('node:fs').writeSync(2, 'x'.repeat(100000)); process.exitCode = 1;\n");
    const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    const output = await applyOp(dir, {
      type: 'bash',
      command: `${quote(process.execPath)} ${quote(script)}`,
    });
    assert.equal(output.result.stderr_truncated, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('a separate interval flag value overrides the default', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-interval-'));
  try {
    const options = parseLiveOptions(['--interval', '17'], cwd);
    assert.strictEqual(options.intervalSec, 17);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

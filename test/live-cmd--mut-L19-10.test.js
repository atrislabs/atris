const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('a leading interval flag uses the following value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-live-options-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const options = parseLiveOptions(['--interval', '37', 'demo'], home);
    assert.strictEqual(options.intervalSec, 37);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('zero interval in an equals flag falls back to the default seconds', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'live-zero-interval-'));
  try {
    const options = parseLiveOptions(['--interval=0'], cwd);
    assert.equal(options.intervalSec, 120);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

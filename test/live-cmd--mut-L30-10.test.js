const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('a leading only flag preserves its separate path prefix', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-only-'));
  try {
    const options = parseLiveOptions(['--only', 'atris/wiki'], cwd);
    assert.strictEqual(options.only, 'atris/wiki');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyOp } = require('../commands/serve');

test('read with an empty path reports the missing path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-path-'));
  try {
    const response = await applyOp(dir, { type: 'read', path: '' });
    assert.match(response.result.error, /required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

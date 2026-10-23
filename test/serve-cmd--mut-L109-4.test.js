const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyOp } = require('../commands/serve');

test('edit accepts a find string exactly at the byte limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-edit-limit-'));
  try {
    // The limit is inclusive and measured in UTF-8 bytes.
    const find = 'é'.repeat(512 * 1024);
    assert.equal(Buffer.byteLength(find, 'utf8'), 1024 * 1024);
    const file = path.join(dir, 'input.txt');
    fs.writeFileSync(file, find, 'utf8');

    const result = await applyOp(dir, {
      type: 'edit',
      path: 'input.txt',
      find,
      replace: 'replacement',
    });

    assert.deepEqual(result, { status: 'ok', result: { replacements: 1 } });
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

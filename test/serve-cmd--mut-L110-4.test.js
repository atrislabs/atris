const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyOp } = require('../commands/serve');

test('edit accepts a replacement of exactly one mebibyte', async (t) => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-edit-limit-'));
  t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
  const target = path.join(workingDir, 'document.txt');
  fs.writeFileSync(target, 'before:needle:after', 'utf8');
  const replacement = 'x'.repeat(1024 * 1024);

  const result = await applyOp(workingDir, {
    type: 'edit',
    path: 'document.txt',
    find: 'needle',
    replace: replacement,
  });

  assert.deepEqual(result, { status: 'ok', result: { replacements: 1 } });
  assert.equal(fs.readFileSync(target, 'utf8'), `before:${replacement}:after`);
});

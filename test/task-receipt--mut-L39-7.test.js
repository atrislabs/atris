const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTaskReceipt } = require('../lib/task-receipt');

test('receipt filename preserves the task identifier instead of a generic task label', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-identifier-'));
  const env = process.env;
  process.env = { ...env, HOME: root };
  try {
    const receipt = writeTaskReceipt({
      taskId: 'CLI-937',
      command: 'node --test',
      root,
      runner: () => ({ status: 0, stdout: 'verification passed', stderr: '' }),
    });
    assert.match(path.basename(receipt.receiptPath), /-task-cli-937-/);
  } finally {
    process.env = env;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

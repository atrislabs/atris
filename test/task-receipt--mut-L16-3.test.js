const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeTaskReceipt } = require('../lib/task-receipt');

test('output at max length is preserved without truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
  try {
    const exact400 = 'a'.repeat(400);
    const receipt = writeTaskReceipt({
      taskId: 'exact-boundary',
      command: 'true',
      root: dir,
      runner: () => ({ status: 0, stdout: exact400, stderr: '' }),
    });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, receipt.receiptPath), 'utf8'));
    assert.strictEqual(saved.result.output, exact400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

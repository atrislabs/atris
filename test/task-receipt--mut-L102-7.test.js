'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTaskReceipt } = require('../lib/task-receipt');

test('a terminated verification preserves its signal in saved evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-evidence-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = root;
    const receipt = writeTaskReceipt({
      taskId: 'terminated-check',
      command: 'kill -TERM $$',
      root,
    });
    const saved = JSON.parse(fs.readFileSync(path.join(root, receipt.receiptPath), 'utf8'));
    assert.strictEqual(saved.result.signal, 'SIGTERM');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

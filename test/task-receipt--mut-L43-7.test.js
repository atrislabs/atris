'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTaskReceipt } = require('../lib/task-receipt');

test('receipt filename preserves the normalized task identifier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-receipt-slug-'));
  try {
    const result = writeTaskReceipt({
      taskId: 'Release Notes',
      command: 'true',
      root,
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const receipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
    const filename = `${receipt.at.slice(0, 10)}-task-release-notes-${receipt.at.replace(/[:.]/g, '-')}.json`;
    assert.equal(result.receiptPath, path.join('atris', 'runs', filename));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

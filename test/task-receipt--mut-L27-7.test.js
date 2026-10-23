const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTaskReceipt } = require('../lib/task-receipt');

test('git repository records non-null commit hash in saved receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-commit-'));
  try {
    const gitDir = path.join(dir, '.git');
    fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'abcdef1234567890abcdef1234567890abcdef12\n');

    const expectedCommit = 'abcdef1234567890abcdef1234567890abcdef12';
    const receipt = writeTaskReceipt({
      taskId: 'TASK-GIT-1',
      command: 'echo test',
      root: dir,
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    });

    const parsed = JSON.parse(fs.readFileSync(path.join(dir, receipt.receiptPath), 'utf8'));
    assert.strictEqual(parsed.commit, expectedCommit);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeTaskReceipt } = require('../lib/task-receipt');

test('receipt preserves the checked-out commit in an initialized repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-head-'));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const env = {
      HOME: root,
      PATH: process.env.PATH || '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Receipt Test',
      GIT_AUTHOR_EMAIL: 'receipt@example.invalid',
      GIT_COMMITTER_NAME: 'Receipt Test',
      GIT_COMMITTER_EMAIL: 'receipt@example.invalid',
      GIT_AUTHOR_DATE: '2024-01-15T12:00:00Z',
      GIT_COMMITTER_DATE: '2024-01-15T12:00:00Z',
    };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'initial');
    const expected = git('rev-parse', 'HEAD');
    const result = writeTaskReceipt({
      root,
      taskId: 'check-head',
      command: 'node --test',
      runner: () => ({ status: 0, stdout: 'check passed\n', stderr: '' }),
    });
    const saved = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
    assert.strictEqual(saved.commit, expected);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

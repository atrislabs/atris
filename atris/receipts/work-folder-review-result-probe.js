'use strict';

// Advisory proof of the existing shared reader, with no production cleanup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeRemovalResult } = require('../../commands/worktree');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-result-')));
try {
  const interrupted = spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], { encoding: 'utf8' });
  assert.equal(interrupted.status, null);
  assert.equal(interrupted.signal, 'SIGTERM');
  assert.equal(interrupted.stderr, '');
  const interruptedDetail = describeRemovalResult(root, interrupted);
  assert.equal(interruptedDetail, 'git removal stopped by SIGTERM');
  console.log(`interrupted: ${interruptedDetail}`);

  const failed = spawnSync(path.join(root, 'missing-git'), [], { encoding: 'utf8' });
  assert.equal(failed.status, null);
  assert.equal(failed.error.code, 'ENOENT');
  const failedDetail = describeRemovalResult(root, failed);
  assert.match(failedDetail, /^git could not run: .*ENOENT$/);
  console.log(`failed launch: ${failedDetail}`);

  const timedOut = spawnSync(process.execPath, ['-e', "process.stdout.write('partial progress'); setInterval(() => {}, 1000)"], { encoding: 'utf8', timeout: 1000 });
  assert.equal(timedOut.status, null);
  assert.equal(timedOut.error.code, 'ETIMEDOUT');
  assert.equal(timedOut.stdout, 'partial progress');
  const timeoutDetail = describeRemovalResult(root, timedOut);
  assert.equal(timeoutDetail, 'git removal timed out');
  console.log(`timeout after partial output: ${timeoutDetail}`);

  // Missing metadata is a contract case, not a claimed real process failure.
  const missingDetail = describeRemovalResult(root, {});
  assert.equal(missingDetail, 'git removal ended without an exit status');
  console.log(`missing metadata (synthetic): ${missingDetail}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

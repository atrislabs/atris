const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { acceptSweepTimeoutMs, describeAcceptKillCause } = require('../commands/autoland');

test('accept sweep timeout keeps the old 300s floor for small queues', () => {
  assert.equal(acceptSweepTimeoutMs(0), 300000);
  assert.equal(acceptSweepTimeoutMs(30), 300000);
});

test('accept sweep timeout grows with the pending queue and caps at 25min', () => {
  assert.equal(acceptSweepTimeoutMs(50), 460000);
  assert.equal(acceptSweepTimeoutMs(207), 1500000);
  assert.equal(acceptSweepTimeoutMs(10000), 1500000);
});

test('a spawnSync timeout really reports error.code ETIMEDOUT', () => {
  const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    encoding: 'utf8',
    timeout: 500,
  });
  assert.equal(result.error && result.error.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGTERM');
});

test('kill cause names a timeout with its real budget', () => {
  const cause = describeAcceptKillCause({ error_code: 'ETIMEDOUT', signal: 'SIGTERM', timeout_ms: 1500000 });
  assert.equal(cause, 'auto-accept timed out at 1500000ms');
});

test('kill cause names other spawn failures and signals', () => {
  assert.equal(describeAcceptKillCause({ error_code: 'ENOENT' }), 'auto-accept spawn failed: ENOENT');
  assert.equal(describeAcceptKillCause({ signal: 'SIGKILL' }), 'auto-accept killed by SIGKILL');
  assert.equal(describeAcceptKillCause({}), null);
});

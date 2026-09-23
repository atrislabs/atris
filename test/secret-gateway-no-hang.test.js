'use strict';

// A failing assertion in test/secret-gateway.test.js used to skip the
// cleanup that closes its https upstream server, so the test process never
// exited. One run sat for seven days. Force the failure and require an exit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('a failing secret gateway test still lets the test process exit', () => {
  const file = path.join(__dirname, 'secret-gateway.test.js');
  const env = { ...process.env, ATRIS_SECRET_GATEWAY_TEST_CHILD_TIMEOUT_MS: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test-name-pattern=supervised child', file], {
    encoding: 'utf8',
    env,
    timeout: 90000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.signal, null, `test process hung and was killed after 90s\n${result.stdout}`);
  assert.equal(result.status, 1, `forced failure should be reported\n${result.stdout}\n${result.stderr}`);
});

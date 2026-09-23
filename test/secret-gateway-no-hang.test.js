'use strict';

// A failing assertion in test/secret-gateway.test.js used to skip the
// cleanup that closes its https upstream server, so the test process never
// exited. One run sat for seven days. Force each failure path and require
// both proof that the path ran and an exit inside the bound.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BOUND_MS = 90000;

function runWithFault(fault, pattern) {
  const env = { ...process.env, ATRIS_SECRET_GATEWAY_TEST_FAULT: fault };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    `--test-name-pattern=${pattern}`,
    path.join(__dirname, 'secret-gateway.test.js'),
  ], { encoding: 'utf8', env, timeout: BOUND_MS, killSignal: 'SIGKILL' });
  return { ...result, elapsedMs: Date.now() - started, output: `${result.stdout}\n${result.stderr}` };
}

function assertFailedAndExited(result, marker) {
  assert.equal(result.signal, null, `test process hung and was killed after ${BOUND_MS}ms\n${result.output}`);
  assert.ok(result.elapsedMs < BOUND_MS, `took ${result.elapsedMs}ms`);
  assert.equal(result.status, 1, result.output);
  assert.ok(result.output.includes(marker), `expected the forced failure "${marker}" in:\n${result.output}`);
}

test('a supervised child timeout fails the test and the process still exits', () => {
  const result = runWithFault('child-timeout', 'supervised child');
  assertFailedAndExited(result, 'spawnBlocking ETIMEDOUT');
  assert.match(result.output, /✖ supervised child gets placeholder only/);
});

test('a gateway that fails to start after the upstream opens still lets the process exit', () => {
  const result = runWithFault('gateway-start', 'fails closed on upstream redirects');
  assertFailedAndExited(result, 'gateway session requires secret');
  assert.match(result.output, /✖ secret gateway fails closed on upstream redirects/);
});

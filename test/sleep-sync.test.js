'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sleepSync } = require('../lib/sleep-sync');
const { withBusyRetry } = require('../lib/task-db');

test('sleepSync waits at least the requested time', () => {
  const start = Date.now();
  sleepSync(50);
  assert.ok(Date.now() - start >= 45, `waited ${Date.now() - start}ms`);
  sleepSync(0);
  sleepSync(-5);
  sleepSync('not a number');
});

test('withBusyRetry retries SQLITE_BUSY without spinning the cpu', () => {
  let calls = 0;
  const op = () => {
    calls += 1;
    if (calls <= 5) {
      const err = new Error('database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return 'ok';
  };
  // A busy-wait loop polls the clock millions of times per wait; a parked
  // thread reads it a handful of times. Counting clock reads is load-proof,
  // unlike comparing cpu time to wall time on a busy machine.
  const realNow = Date.now;
  let clockReads = 0;
  Date.now = () => { clockReads += 1; return realNow(); };
  const start = realNow();
  let result;
  try { result = withBusyRetry(op); } finally { Date.now = realNow; }
  const waitedMs = realNow() - start;
  assert.equal(result, 'ok');
  assert.equal(calls, 6);
  assert.ok(waitedMs >= 150, `backoff should wait, took ${waitedMs}ms`);
  assert.ok(clockReads < 100, `clock read ${clockReads} times while waiting`);
});

test('withBusyRetry does not retry other errors', () => {
  let calls = 0;
  assert.throws(() => withBusyRetry(() => { calls += 1; throw new Error('no such table'); }), /no such table/);
  assert.equal(calls, 1);
});

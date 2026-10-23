'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// hermetic: nothing here may touch the real ~/.atris
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-job-poll-ms-'));
process.env.HOME = HOME;
process.env.ATRIS_HOME = path.join(HOME, '.atris');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_') && key !== 'ATRIS_HOME') delete process.env[key];
}

const gmBet = require('../lib/gm-bet');
const { JOB_POLL_MS } = gmBet;

// setInterval treats anything above a signed 32-bit int as 1ms
const MAX_TIMER_MS = 2 ** 31 - 1;

test('JOB_POLL_MS is the 25 second poll the desk documents', () => {
  assert.equal(JOB_POLL_MS, 25000);
  assert.equal(JOB_POLL_MS / 1000, 25);
});

test('JOB_POLL_MS is a plain number, not a function or string', () => {
  assert.equal(typeof JOB_POLL_MS, 'number');
  assert.ok(Number.isFinite(JOB_POLL_MS));
  assert.ok(Number.isInteger(JOB_POLL_MS));
  assert.notEqual(typeof JOB_POLL_MS, 'function');
});

test('JOB_POLL_MS is truthy, so the desk turns polling on', () => {
  // createBetDesk only starts its timer when pollMs is truthy
  assert.ok(JOB_POLL_MS > 0);
  assert.equal(Boolean(JOB_POLL_MS), true);
});

test('JOB_POLL_MS is a safe setInterval delay', () => {
  assert.ok(JOB_POLL_MS >= 1000, 'polling faster than once a second would hammer the mission files');
  assert.ok(JOB_POLL_MS <= MAX_TIMER_MS, 'a delay past 2^31-1 would fire every 1ms');
});

test('JOB_POLL_MS polls many times inside one stall window', () => {
  assert.equal(typeof gmBet.STALL_MS, 'number');
  assert.ok(JOB_POLL_MS < gmBet.STALL_MS);
  assert.ok(Math.floor(gmBet.STALL_MS / JOB_POLL_MS) >= 100);
});

test('JOB_POLL_MS is exported alongside the other desk timing values', () => {
  const names = Object.keys(gmBet);
  assert.ok(names.includes('JOB_POLL_MS'));
  assert.ok(names.includes('STALL_MS'));
  assert.ok(names.includes('BACKOFF_MS'));
  assert.equal(Object.getOwnPropertyDescriptor(gmBet, 'JOB_POLL_MS').value, 25000);
});

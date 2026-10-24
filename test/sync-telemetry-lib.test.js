'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-telemetry-'));
process.env.HOME = home;

// The module binds this helper at load time. Replace it first so a post never opens a socket.
const api = require('../utils/api');
const calls = [];
let apiBehavior = async () => ({ ok: true, status: 200, data: {} });
api.apiRequestJson = (pathname, options) => {
  calls.push({ pathname, options });
  return apiBehavior();
};

const { emitSyncEvent, startTimer } = require('../lib/sync-telemetry');
const cliVersion = require('../package.json').version;

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('startTimer reports a non-negative elapsed millisecond count', () => {
  const before = Date.now();
  const elapsed = startTimer();
  const value = elapsed();
  const after = Date.now();

  assert.equal(typeof elapsed, 'function');
  assert.equal(typeof value, 'number');
  assert.equal(Number.isFinite(value), true);
  assert.ok(value >= 0);
  assert.ok(value <= (after - before));
});

test('emitSyncEvent skips the post when a required field is missing', async () => {
  const before = calls.length;
  const missing = [
    ['', 'biz', 'ws', 'push', 'ok'],
    ['token', '', 'ws', 'push', 'ok'],
    ['token', 'biz', '', 'push', 'ok'],
    ['token', 'biz', 'ws', '', 'ok'],
    ['token', 'biz', 'ws', 'push', ''],
    [null, 'biz', 'ws', 'pull', 'failed'],
  ];

  for (const args of missing) {
    const sent = await emitSyncEvent(...args, 12, { bytes_transferred: 9 });
    assert.equal(sent, false);
  }

  assert.equal(calls.length, before);
});

test('emitSyncEvent posts a clamped event and returns true', async () => {
  calls.length = 0;
  apiBehavior = async () => ({ ok: true, status: 200, data: {} });

  const detail = `boom-${'x'.repeat(500)}`;
  const sent = await emitSyncEvent('token-1', 'biz-1', 'ws-1', 'push', 'failed', 10.6, {
    bytes_transferred: 40,
    bytes_changed: 12,
    files_pushed: 3,
    files_deleted: 1,
    files_unchanged: 8,
    error_detail: detail,
  });

  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.pathname, '/atris-sync/telemetry');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.token, 'token-1');
  assert.equal(call.options.timeoutMs, 2000);
  assert.equal(call.options.retries, 0);
  assert.equal(call.options.body.business_id, 'biz-1');
  assert.equal(call.options.body.workspace_id, 'ws-1');
  assert.equal(call.options.body.op, 'push');
  assert.equal(call.options.body.outcome, 'failed');
  assert.equal(call.options.body.latency_ms, 11);
  assert.equal(call.options.body.bytes_transferred, 40);
  assert.equal(call.options.body.bytes_changed, 12);
  assert.equal(call.options.body.files_pushed, 3);
  assert.equal(call.options.body.files_deleted, 1);
  assert.equal(call.options.body.files_unchanged, 8);
  assert.equal(call.options.body.cli_version, cliVersion);
  assert.equal(call.options.body.error_detail, detail.slice(0, 500));
  assert.equal(call.options.body.error_detail.length, 500);
});

test('emitSyncEvent defaults empty counters and returns false when the post throws', async () => {
  calls.length = 0;
  apiBehavior = async () => ({ ok: false, status: 500, data: null });

  const quiet = await emitSyncEvent('token-2', 'biz-2', 'ws-2', 'pull', 'ok', -25);
  assert.equal(quiet, true);
  assert.equal(calls[0].options.body.latency_ms, 0);
  assert.equal(calls[0].options.body.bytes_transferred, 0);
  assert.equal(calls[0].options.body.bytes_changed, 0);
  assert.equal(calls[0].options.body.files_pushed, 0);
  assert.equal(calls[0].options.body.files_deleted, 0);
  assert.equal(calls[0].options.body.files_unchanged, 0);
  assert.equal(Object.hasOwn(calls[0].options.body, 'error_detail'), false);

  apiBehavior = async () => {
    throw new Error('control plane down');
  };
  const failed = await emitSyncEvent('token-3', 'biz-3', 'ws-3', 'pull', 'failed', 4, {
    error_detail: 404,
  });
  assert.equal(failed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.body.error_detail, '404');
  assert.equal(calls[1].options.body.latency_ms, 4);
});

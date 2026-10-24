'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-finished-receipt-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { isFinishedReceipt } = require('../lib/workforce-presence');

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('a completed receipt with a fixed finish time is finished, and a live run is not', () => {
  assert.strictEqual(isFinishedReceipt({
    status: 'completed',
    engine: 'codex',
    started_at: '2026-08-15T23:30:00.000Z',
    finished_at: '2026-08-16T00:10:00.000Z',
    result: { kind: 'dispatch_landed', passed: true },
  }), true);

  assert.strictEqual(isFinishedReceipt({
    status: 'done',
    finished_at: '2026-08-16T00:10:00.000Z',
  }), true);

  assert.strictEqual(isFinishedReceipt({
    status: 'running',
    pid: 101,
    engine: 'codex',
    started_at: '2026-08-16T00:37:28.000Z',
  }), false);

  assert.strictEqual(isFinishedReceipt({
    status: 'working',
    started_at: '2026-08-16T00:37:28.000Z',
  }), false);
});

test('a terminal status finishes a receipt even without a time, and a finish time beats a live status', () => {
  assert.strictEqual(isFinishedReceipt({ status: 'failed' }), true);
  assert.strictEqual(isFinishedReceipt({ status: 'presumed_dead' }), true);
  assert.strictEqual(isFinishedReceipt({ status: 'timed_out' }), true);
  assert.strictEqual(isFinishedReceipt({ status: '  COMPLETED  ' }), true);

  assert.strictEqual(isFinishedReceipt({
    status: 'running',
    finished_at: '2026-08-16T00:10:00.000Z',
  }), true);

  assert.strictEqual(isFinishedReceipt({
    status: 'in_progress',
    finished_at: '',
  }), false);

  assert.strictEqual(isFinishedReceipt({
    status: 'active',
    finished_at: 0,
  }), false);

  assert.strictEqual(isFinishedReceipt({ status: 'still-going' }), false);
});

test('an empty, missing, or unusable receipt is not finished and does not throw', () => {
  assert.strictEqual(isFinishedReceipt(null), false);
  assert.strictEqual(isFinishedReceipt(undefined), false);
  assert.strictEqual(isFinishedReceipt(), false);
  assert.strictEqual(isFinishedReceipt({}), false);
  assert.strictEqual(isFinishedReceipt({ status: '' }), false);
  assert.strictEqual(isFinishedReceipt({ status: '   ', finished_at: '' }), false);
  assert.strictEqual(isFinishedReceipt('completed'), false);
  assert.strictEqual(isFinishedReceipt(0), false);
  assert.doesNotThrow(() => {
    isFinishedReceipt(null);
    isFinishedReceipt(undefined);
    isFinishedReceipt({});
  });
});

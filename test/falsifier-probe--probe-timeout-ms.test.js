'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'falsifier-probe-timeout-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { PROBE_TIMEOUT_MS } = require('../lib/falsifier-probe');

test('the probe timeout is sixty thousand milliseconds', () => {
  assert.strictEqual(PROBE_TIMEOUT_MS, 60000);
  assert.strictEqual(PROBE_TIMEOUT_MS, 60 * 1000);
  assert.strictEqual(typeof PROBE_TIMEOUT_MS, 'number');
});

test('the timeout lands on a whole minute, which is the edge the reason text prints', () => {
  assert.strictEqual(PROBE_TIMEOUT_MS % 1000, 0);
  assert.strictEqual(PROBE_TIMEOUT_MS / 1000, 60);
  assert.strictEqual(Number.isSafeInteger(PROBE_TIMEOUT_MS), true);
  assert.ok(PROBE_TIMEOUT_MS > 0);
});

test('an empty timeout is not used, and calling the number throws', () => {
  assert.notStrictEqual(PROBE_TIMEOUT_MS, 0);
  assert.notStrictEqual(PROBE_TIMEOUT_MS, null);
  assert.notStrictEqual(PROBE_TIMEOUT_MS, undefined);
  assert.notStrictEqual(PROBE_TIMEOUT_MS, '');
  assert.strictEqual(Number.isFinite(PROBE_TIMEOUT_MS), true);
  assert.throws(() => {
    PROBE_TIMEOUT_MS();
  }, TypeError);
});

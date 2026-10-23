'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-valid-cloud-lanes-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { VALID_CLOUD_LANES } = require('../lib/cloud-mission');

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('known cloud lanes are fast, pro, and max', () => {
  assert.strictEqual(VALID_CLOUD_LANES.has('fast'), true);
  assert.strictEqual(VALID_CLOUD_LANES.has('pro'), true);
  assert.strictEqual(VALID_CLOUD_LANES.has('max'), true);
  assert.deepStrictEqual([...VALID_CLOUD_LANES], ['fast', 'pro', 'max']);
});

test('near misses are not cloud lanes', () => {
  assert.strictEqual(VALID_CLOUD_LANES.has('Fast'), false);
  assert.strictEqual(VALID_CLOUD_LANES.has('fast '), false);
  assert.strictEqual(VALID_CLOUD_LANES.has('ultra'), false);
});

test('empty and missing lane values are not cloud lanes', () => {
  assert.strictEqual(VALID_CLOUD_LANES.has(''), false);
  assert.strictEqual(VALID_CLOUD_LANES.has(undefined), false);
  assert.strictEqual(VALID_CLOUD_LANES.has(null), false);
});

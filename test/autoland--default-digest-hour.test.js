const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-digest-hour-'));
process.env.HOME = tempHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { DEFAULT_DIGEST_HOUR } = require('../lib/autoland');

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('default digest hour is 9, so the daily digest goes out at 9:00', () => {
  assert.strictEqual(DEFAULT_DIGEST_HOUR, 9);
  assert.strictEqual(`${DEFAULT_DIGEST_HOUR}:00`, '9:00');
});

test('default digest hour is a whole hour on the 24-hour clock', () => {
  assert.strictEqual(typeof DEFAULT_DIGEST_HOUR, 'number');
  assert.ok(Number.isInteger(DEFAULT_DIGEST_HOUR));
  assert.ok(DEFAULT_DIGEST_HOUR >= 0 && DEFAULT_DIGEST_HOUR <= 23);
});

test('default digest hour is a real number, not a missing or non-numeric value', () => {
  assert.notStrictEqual(DEFAULT_DIGEST_HOUR, undefined);
  assert.notStrictEqual(DEFAULT_DIGEST_HOUR, null);
  assert.ok(Number.isFinite(Number(DEFAULT_DIGEST_HOUR)));
  assert.notStrictEqual(DEFAULT_DIGEST_HOUR, '9');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { gfMul } = require('../lib/qr');

// GF(2^8) products under the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
// 2 * 128 reduces to 0x1d. 0x53 * 0xca was multiplied by hand (Russian peasant).
test('gfMul multiplies ordinary bytes in the QR field', () => {
  assert.strictEqual(gfMul(1, 0x53), 0x53);
  assert.strictEqual(gfMul(0x53, 1), 0x53);
  assert.strictEqual(gfMul(2, 2), 4);
  assert.strictEqual(gfMul(2, 0x80), 0x1d);
  assert.strictEqual(gfMul(0x80, 2), 0x1d);
  assert.strictEqual(gfMul(0x53, 0xca), 0x8f);
  assert.strictEqual(gfMul(0xca, 0x53), 0x8f);
  for (let n = 0; n < 256; n += 1) {
    const product = gfMul(n, 0x53);
    assert.ok(Number.isInteger(product) && product >= 0 && product <= 255);
  }
});

test('gfMul returns zero when either factor is zero', () => {
  assert.strictEqual(gfMul(0, 0), 0);
  assert.strictEqual(gfMul(0, 0xff), 0);
  assert.strictEqual(gfMul(0xff, 0), 0);
  assert.strictEqual(gfMul(0, 1), 0);
  assert.strictEqual(gfMul(1, 0), 0);
});

test('gfMul treats empty and non-byte inputs as a byte product', () => {
  assert.strictEqual(gfMul(undefined, undefined), 0);
  assert.strictEqual(gfMul(null, null), 0);
  assert.strictEqual(gfMul(undefined, 3), 0);
  assert.strictEqual(gfMul(3, undefined), 0);
  assert.strictEqual(gfMul(null, 7), 0);
  // Only the low eight bits survive: 0x101 * 1 === 1, and bit 8 of y is ignored.
  assert.strictEqual(gfMul(0x101, 1), 1);
  assert.strictEqual(gfMul(1, 0x101), 1);
  assert.strictEqual(gfMul(0x1d, 0x100), 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeQr } = require('../lib/qr');

test('version seven includes the version information readers need', () => {
  const { modules, size } = encodeQr('x'.repeat(110));
  // The standard's version-seven BCH codeword, including its error correction.
  let versionBits = 0;
  for (let i = 0; i < 18; i += 1) {
    if (modules[Math.floor(i / 3)][size - 11 + i % 3]) {
      versionBits |= 1 << i;
    }
  }
  assert.equal(versionBits, 0x07c94);
});

const test = require('node:test');
const assert = require('node:assert');
const { isHex } = require('../lib/theme');

test('isHex accepts full and shorthand hexadecimal colors', () => {
  for (const value of ['#00A88F', '#abcdef', 'Ab12Cd', '#abc', 'F0a', '#000', '#FFFFFF']) {
    assert.strictEqual(isHex(value), true, JSON.stringify(value));
  }
});

test('isHex trims surrounding whitespace but rejects malformed colors', () => {
  assert.strictEqual(isHex(' \t#AbC123\n'), true);
  for (const value of ['#12', '#1234', '#12345', '#1234567', '#12345678', '##abc', '#ggg', '#ab cd', 'red', '0xabcdef']) {
    assert.strictEqual(isHex(value), false, JSON.stringify(value));
  }
});

test('isHex returns false for empty and missing values', () => {
  for (const value of ['', ' \t\n', '#', null, undefined]) {
    assert.strictEqual(isHex(value), false, String(value));
  }
  assert.strictEqual(isHex(), false);
});

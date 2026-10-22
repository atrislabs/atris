'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { encodeQr, qrLines, rsDivisor, rsRemainder, dataCodewords, alignmentPositions } = require('../lib/qr');

function digest(modules) {
  return crypto.createHash('sha1').update(modules.map(r => r.map(m => (m ? 1 : 0)).join('')).join('\n')).digest('hex');
}

test('reed-solomon matches the spec worked example (HELLO WORLD, 1-M)', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('capacity and alignment tables for level M', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(dataCodewords), [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(5), [6, 30]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(10), [6, 28, 50]);
});

test('picks the smallest version that fits and refuses past version 10', () => {
  assert.equal(encodeQr('x'.repeat(14)).version, 1);
  assert.equal(encodeQr('x'.repeat(15)).version, 2);
  assert.equal(encodeQr('x'.repeat(213)).version, 10);
  assert.throws(() => encodeQr('x'.repeat(214)), /too long/);
});

test('finder patterns, timing, and the dark module sit where readers look', () => {
  const { modules, size } = encodeQr('hello world');
  assert.equal(size, 21);
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let d = 0; d < 7; d += 1) {
      assert.equal(modules[y0][x0 + d], true, 'finder top edge');
      assert.equal(modules[y0 + 6][x0 + d], true, 'finder bottom edge');
    }
    assert.equal(modules[y0 + 1][x0 + 1], false, 'finder light ring');
    assert.equal(modules[y0 + 3][x0 + 3], true, 'finder center');
  }
  for (let i = 8; i < size - 8; i += 1) assert.equal(modules[6][i], i % 2 === 0, 'timing row');
  assert.equal(modules[size - 8][8], true, 'dark module');
});

// These matrices were decoded back to the exact text with macOS CoreImage's
// QR reader when the encoder was written (every mask, versions 1 to 10).
test('golden matrices stay byte for byte the same', () => {
  const cases = [
    ['HI', 1, 3, 'e052090275b6049d1f232387457ab05411f100dc'],
    ['hello world', 1, 3, '95b15df8327511e2c54d6ee279e0ebdeada4e1dc'],
    ['http://192.168.1.23:7777/?t=Zm9vYmFyYmF6cXV4cXV1eHh5enp6enp6enp6enp6enp6enp6eno', 5, 3, '1887bcf2478fde549929cb7206ba9ea1baa17092'],
    ['L'.repeat(213), 10, 2, '2af04281a73f4020fa80657fd93688956170377d'],
  ];
  for (const [text, version, mask, sha] of cases) {
    const q = encodeQr(text);
    assert.equal(q.version, version, text.slice(0, 12));
    assert.equal(q.mask, mask, text.slice(0, 12));
    assert.equal(digest(q.modules), sha, text.slice(0, 12));
  }
});

test('terminal lines: two rows per line, quiet zone included', () => {
  const plain = qrLines('hello world', { color: false, quiet: 2 });
  assert.equal(plain.length, Math.ceil((21 + 4) / 2));
  assert.ok(plain.every(line => [...line].length === 25));
  const colored = qrLines('hello world');
  assert.ok(colored.every(line => line.startsWith('\x1b[30;107m') && line.endsWith('\x1b[0m')));
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { hexToRgb } = require('../lib/theme');

test('hexToRgb parses six-digit hex with and without the hash', () => {
  assert.deepStrictEqual(hexToRgb('#F59E0B'), { r: 245, g: 158, b: 11 });
  assert.deepStrictEqual(hexToRgb('F59E0B'), { r: 245, g: 158, b: 11 });
  assert.deepStrictEqual(hexToRgb('#000000'), { r: 0, g: 0, b: 0 });
  assert.deepStrictEqual(hexToRgb('#FFFFFF'), { r: 255, g: 255, b: 255 });
});

test('hexToRgb is case-insensitive', () => {
  assert.deepStrictEqual(hexToRgb('#abcdef'), { r: 171, g: 205, b: 239 });
  assert.deepStrictEqual(hexToRgb('#ABCDEF'), hexToRgb('#abcdef'));
  assert.deepStrictEqual(hexToRgb('#aBcDeF'), hexToRgb('#ABCDEF'));
});

test('hexToRgb expands three-digit shorthand by doubling each digit', () => {
  assert.deepStrictEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepStrictEqual(hexToRgb('#0af'), { r: 0, g: 170, b: 255 });
  assert.deepStrictEqual(hexToRgb('0af'), hexToRgb('#00aaff'));
});

test('hexToRgb trims surrounding whitespace and accepts only one leading hash', () => {
  assert.deepStrictEqual(hexToRgb('  #141110  '), { r: 20, g: 17, b: 16 });
  assert.deepStrictEqual(hexToRgb('\t7F97A4\n'), { r: 127, g: 151, b: 164 });
  assert.strictEqual(hexToRgb('##141110'), null);
});

test('hexToRgb returns null for empty and missing input', () => {
  assert.strictEqual(hexToRgb(''), null);
  assert.strictEqual(hexToRgb('   '), null);
  assert.strictEqual(hexToRgb('#'), null);
  assert.strictEqual(hexToRgb(undefined), null);
  assert.strictEqual(hexToRgb(null), null);
  assert.strictEqual(hexToRgb(), null);
});

test('hexToRgb returns null for wrong lengths and non-hex characters', () => {
  assert.strictEqual(hexToRgb('#ff'), null);
  assert.strictEqual(hexToRgb('#ffff'), null);
  assert.strictEqual(hexToRgb('#fffff'), null);
  assert.strictEqual(hexToRgb('#fffffff'), null);
  assert.strictEqual(hexToRgb('#ffffffff'), null);
  assert.strictEqual(hexToRgb('#GGGGGG'), null);
  assert.strictEqual(hexToRgb('#12345Z'), null);
  assert.strictEqual(hexToRgb('#xyz'), null);
  assert.strictEqual(hexToRgb('red'), null);
});

test('hexToRgb coerces non-string input through String() instead of throwing', () => {
  assert.deepStrictEqual(hexToRgb(123456), { r: 18, g: 52, b: 86 });
  assert.strictEqual(hexToRgb({}), null);
  assert.strictEqual(hexToRgb([]), null);
  assert.strictEqual(hexToRgb(true), null);
});

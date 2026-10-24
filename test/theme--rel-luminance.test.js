'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { relLuminance } = require('../lib/theme');

// WCAG relative luminance, checked against the sRGB formula, not a snapshot of the call.
function near(actual, expected) {
  assert.ok(Number.isFinite(actual), `luminance ${actual} is not a finite number`);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not within 1e-12 of ${expected}`);
}

test('normal hex colors return their relative luminance', () => {
  assert.strictEqual(relLuminance('#000000'), 0);
  assert.strictEqual(relLuminance('#FFFFFF'), 1);
  assert.strictEqual(relLuminance('#FF0000'), 0.2126);
  assert.strictEqual(relLuminance('#00FF00'), 0.7152);
  assert.strictEqual(relLuminance('#0000FF'), 0.0722);
  near(relLuminance('#F59E0B'), 0.43890358994810874);
  near(relLuminance('#808080'), 0.21586050011389923);
});

test('short hex, case, spacing, and the sRGB knee still resolve', () => {
  assert.strictEqual(relLuminance('#fff'), relLuminance('#FFFFFF'));
  assert.strictEqual(relLuminance('  #000  '), 0);
  assert.strictEqual(relLuminance('#f59e0b'), relLuminance('#F59E0B'));
  // channel 10 stays on the linear side of 0.03928; channel 11 crosses into gamma
  near(relLuminance('#0A0A0A'), 0.003035269835488375);
  near(relLuminance('#0B0B0B'), 0.0033465357638991604);
  assert.ok(relLuminance('#0B0B0B') > relLuminance('#0A0A0A'));
});

test('empty and unusable colors return zero', () => {
  assert.strictEqual(relLuminance(''), 0);
  assert.strictEqual(relLuminance('   '), 0);
  assert.strictEqual(relLuminance(null), 0);
  assert.strictEqual(relLuminance(undefined), 0);
  assert.strictEqual(relLuminance('nope'), 0);
  assert.strictEqual(relLuminance('#gg0000'), 0);
  assert.strictEqual(relLuminance('#12345'), 0);
});

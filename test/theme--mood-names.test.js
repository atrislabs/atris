'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MOOD_NAMES, MOODS, FONT_PERSONALITIES, buildTheme, resolveMode } = require('../lib/theme');

test('MOOD_NAMES lists the five built-in moods in picker order', () => {
  assert.ok(Array.isArray(MOOD_NAMES));
  assert.deepStrictEqual(MOOD_NAMES, ['editorial', 'technical', 'noir', 'paper', 'vivid']);
  assert.strictEqual(MOOD_NAMES.length, 5);
});

test('MOOD_NAMES is exactly the key set of MOODS, with no duplicates or blanks', () => {
  assert.deepStrictEqual(MOOD_NAMES, Object.keys(MOODS));
  assert.strictEqual(new Set(MOOD_NAMES).size, MOOD_NAMES.length);
  for (const name of MOOD_NAMES) {
    assert.strictEqual(typeof name, 'string');
    assert.ok(name.length > 0);
    assert.strictEqual(name, name.trim());
    assert.strictEqual(name, name.toLowerCase());
  }
});

test('every name in MOOD_NAMES points at a complete mood the picker can print', () => {
  for (const name of MOOD_NAMES) {
    const mood = MOODS[name];
    assert.ok(mood, `${name} has a mood`);
    assert.strictEqual(typeof mood.blurb, 'string');
    assert.ok(mood.blurb.length > 0, `${name} has a blurb`);
    assert.ok(FONT_PERSONALITIES[mood.fonts], `${name} uses a known font pairing`);
    assert.ok(mood.modes[mood.defaultMode], `${name} defines its default mode`);
    assert.ok(mood.swatches.length > 0, `${name} has at least one accent swatch`);
  }
});

test('every name in MOOD_NAMES builds a theme from that mood\'s own surface', () => {
  for (const name of MOOD_NAMES) {
    const surface = MOODS[name].modes[resolveMode(name)];
    const theme = buildTheme({ mood: name });
    assert.strictEqual(theme.color.bg, surface.bg, `${name} bg`);
    assert.strictEqual(theme.color.ink, surface.ink, `${name} ink`);
    assert.strictEqual(theme.color.accent, MOODS[name].swatches[0], `${name} accent`);
  }
});

test('names outside MOOD_NAMES are not moods and fall back to editorial', () => {
  for (const bad of ['', ' ', 'Editorial', 'editorial ', 'neon', 'constructor', '__proto__', undefined, null, 0]) {
    assert.ok(!MOOD_NAMES.includes(bad), `${String(bad)} is not a mood name`);
  }
  assert.deepStrictEqual(buildTheme({ mood: 'neon' }), buildTheme({ mood: 'editorial' }));
  assert.deepStrictEqual(buildTheme({}), buildTheme({ mood: 'editorial' }));
});

test('picker lookups on MOOD_NAMES degrade safely for bad or out-of-range picks', () => {
  // mirrors commands/theme.js: indexOf for the default, 1-based index for the pick
  assert.strictEqual(MOOD_NAMES.indexOf('neon'), -1);
  assert.strictEqual(Math.max(0, MOOD_NAMES.indexOf('neon')), 0);
  assert.strictEqual(MOOD_NAMES.indexOf('vivid'), MOOD_NAMES.length - 1);
  assert.strictEqual(MOOD_NAMES[parseInt('abc', 10) - 1], undefined);
  assert.strictEqual(MOOD_NAMES[parseInt('0', 10) - 1], undefined);
  assert.strictEqual(MOOD_NAMES[parseInt('6', 10) - 1], undefined);
  assert.strictEqual(MOOD_NAMES[parseInt('3', 10) - 1], 'noir');
});

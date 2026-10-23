'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveFonts, FONT_PERSONALITIES, MOODS } = require('../lib/theme');

test('resolveFonts returns the mood font pairing when no spec is given', () => {
  assert.deepStrictEqual(resolveFonts(undefined, 'editorial'), {
    display: 'Fraunces', body: 'Outfit', mono: 'IBM Plex Mono',
  });
  assert.deepStrictEqual(resolveFonts(undefined, 'technical'), {
    display: 'Space Grotesk', body: 'Outfit', mono: 'IBM Plex Mono',
  });
  assert.deepStrictEqual(resolveFonts(null, 'paper'), FONT_PERSONALITIES['editorial-serif']);
  assert.deepStrictEqual(resolveFonts('', 'noir'), FONT_PERSONALITIES['clean-sans']);
});

test('resolveFonts uses each mood\'s own personality for every known mood', () => {
  for (const [name, mood] of Object.entries(MOODS)) {
    assert.deepStrictEqual(resolveFonts(undefined, name), FONT_PERSONALITIES[mood.fonts], name);
  }
});

test('resolveFonts picks a named personality over the mood default', () => {
  assert.deepStrictEqual(resolveFonts('mono-forward', 'editorial'), {
    display: 'Space Grotesk', body: 'IBM Plex Mono', mono: 'IBM Plex Mono',
  });
  assert.deepStrictEqual(resolveFonts('editorial-serif', 'technical'), FONT_PERSONALITIES['editorial-serif']);
});

test('resolveFonts falls back to the mood default for an unknown personality name', () => {
  assert.deepStrictEqual(resolveFonts('comic-sans-chaos', 'technical'), FONT_PERSONALITIES['clean-sans']);
  assert.deepStrictEqual(resolveFonts('comic-sans-chaos', 'paper'), FONT_PERSONALITIES['editorial-serif']);
});

test('resolveFonts falls back to the editorial mood when the mood is unknown or missing', () => {
  assert.deepStrictEqual(resolveFonts(undefined, 'nonsense'), FONT_PERSONALITIES['editorial-serif']);
  assert.deepStrictEqual(resolveFonts(undefined, undefined), FONT_PERSONALITIES['editorial-serif']);
  assert.deepStrictEqual(resolveFonts(), FONT_PERSONALITIES['editorial-serif']);
  assert.deepStrictEqual(resolveFonts('unknown-name', 'nonsense'), FONT_PERSONALITIES['editorial-serif']);
  assert.deepStrictEqual(resolveFonts('clean-sans', 'nonsense'), FONT_PERSONALITIES['clean-sans']);
});

test('resolveFonts layers an object spec over the mood pairing', () => {
  assert.deepStrictEqual(resolveFonts({ display: 'Lora' }, 'editorial'), {
    display: 'Lora', body: 'Outfit', mono: 'IBM Plex Mono',
  });
  assert.deepStrictEqual(resolveFonts({ body: 'Inter', mono: 'Menlo' }, 'technical'), {
    display: 'Space Grotesk', body: 'Inter', mono: 'Menlo',
  });
  assert.deepStrictEqual(resolveFonts({}, 'vivid'), FONT_PERSONALITIES['clean-sans']);
});

test('resolveFonts keeps extra keys from an object spec and follows the mood for the base', () => {
  assert.deepStrictEqual(resolveFonts({ accent: 'Caveat' }, 'paper'), {
    display: 'Fraunces', body: 'Outfit', mono: 'IBM Plex Mono', accent: 'Caveat',
  });
  assert.deepStrictEqual(resolveFonts({ display: 'Lora' }, 'nonsense'), {
    display: 'Lora', body: 'Outfit', mono: 'IBM Plex Mono',
  });
});

test('resolveFonts returns a fresh object so callers cannot corrupt the shared personalities', () => {
  const named = resolveFonts('clean-sans', 'editorial');
  named.display = 'Mutated';
  assert.strictEqual(FONT_PERSONALITIES['clean-sans'].display, 'Space Grotesk');

  const fallback = resolveFonts(undefined, 'editorial');
  fallback.body = 'Mutated';
  assert.strictEqual(FONT_PERSONALITIES['editorial-serif'].body, 'Outfit');

  const layered = resolveFonts({ display: 'Lora' }, 'editorial');
  layered.mono = 'Mutated';
  assert.strictEqual(FONT_PERSONALITIES['editorial-serif'].mono, 'IBM Plex Mono');

  assert.notStrictEqual(resolveFonts('clean-sans', 'editorial'), resolveFonts('clean-sans', 'editorial'));
});

test('resolveFonts does not change the object spec it was given', () => {
  const spec = Object.freeze({ display: 'Lora' });
  const out = resolveFonts(spec, 'editorial');
  assert.deepStrictEqual(spec, { display: 'Lora' });
  assert.notStrictEqual(out, spec);
});

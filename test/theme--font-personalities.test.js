const test = require('node:test');
const assert = require('node:assert');
const { FONT_PERSONALITIES, MOODS } = require('../lib/theme');

// FONT_PERSONALITIES is a plain data object, not a function, so these tests read it directly.
// Nothing here writes to disk or reads the environment.

test('maps each named personality to its display, body, and mono fonts', () => {
  assert.deepStrictEqual(FONT_PERSONALITIES, {
    'editorial-serif': { display: 'Fraunces', body: 'Outfit', mono: 'IBM Plex Mono' },
    'clean-sans': { display: 'Space Grotesk', body: 'Outfit', mono: 'IBM Plex Mono' },
    'mono-forward': { display: 'Space Grotesk', body: 'IBM Plex Mono', mono: 'IBM Plex Mono' },
  });
});

test('every personality has exactly display, body, and mono as non-empty strings, and every mood points at a real one', () => {
  for (const [name, fonts] of Object.entries(FONT_PERSONALITIES)) {
    assert.deepStrictEqual(Object.keys(fonts).sort(), ['body', 'display', 'mono'], name);
    for (const role of ['display', 'body', 'mono']) {
      assert.strictEqual(typeof fonts[role], 'string', `${name}.${role} is not a string`);
      assert.ok(fonts[role].trim().length > 0, `${name}.${role} is empty`);
    }
  }
  for (const [mood, def] of Object.entries(MOODS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FONT_PERSONALITIES, def.fonts),
      `mood "${mood}" points at unknown personality "${def.fonts}"`,
    );
  }
});

test('unknown, empty, or inherited keys resolve to nothing', () => {
  assert.strictEqual(FONT_PERSONALITIES['no-such-font'], undefined);
  assert.strictEqual(FONT_PERSONALITIES[''], undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(FONT_PERSONALITIES, 'toString'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(FONT_PERSONALITIES, 'constructor'), false);
  assert.deepStrictEqual(Object.keys(FONT_PERSONALITIES), ['editorial-serif', 'clean-sans', 'mono-forward']);
});

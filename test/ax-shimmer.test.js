const test = require('node:test');
const assert = require('node:assert/strict');
const { renderShimmerText, shimmerStyleForDistance, ANSI } = require('../lib/ax-shimmer');

test('renderShimmerText animates pure grayscale luminance across ticks', () => {
  const colored = { color: true, isTTY: true };
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const a = renderShimmerText('Working', 2, colored);
    const b = renderShimmerText('Working', 8, colored);
    assert.match(a, /W.*o.*r.*k.*i.*n.*g/);
    assert.notEqual(a, b);
    assert.match(a, /\x1b\[97m/);
    assert.doesNotMatch(a, /\x1b\[1m/);
    assert.doesNotMatch(a, /\x1b\[3[56]m/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('shimmerStyleForDistance is grayscale only with a bright peak and dim trough', () => {
  assert.deepEqual(shimmerStyleForDistance(0), [ANSI.bright]);
  assert.deepEqual(shimmerStyleForDistance(3), [ANSI.dim, ANSI.muted]);
  assert.ok(!shimmerStyleForDistance(1).includes('\x1b[1m'));
});

test('renderShimmerText is plain without color', () => {
  assert.equal(renderShimmerText('Reading', 4, { color: false }), 'Reading');
});

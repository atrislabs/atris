const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReelFrame, revealCss, reelFrames, win } = require('../lib/reel');
const { SIZES } = require('../lib/card');

test('reelFrames returns seconds*fps frames from 0 to 1', () => {
  const f = reelFrames(2, 20);
  assert.equal(f.length, 40);
  assert.equal(f[0], 0);
  assert.equal(f[f.length - 1], 1);
});

test('reelFrames never returns fewer than 2 frames', () => {
  assert.ok(reelFrames(0, 0).length >= 2);
});

test('at t=1 every element is fully revealed (final card state)', () => {
  const css = revealCss(1);
  assert.ok(!/opacity:0\.\d/.test(css), 'no partial opacities at t=1');
  assert.match(css, /\.headline\{opacity:1\.000;transform:translateY\(0\.00px\)\}/);
  assert.match(css, /\.foot\{opacity:1\.000/);
});

test('at t=0 nothing is revealed yet (clean fade-in start)', () => {
  const css = revealCss(0);
  assert.match(css, /\.headline\{opacity:0\.000/);
  assert.match(css, /\.rule\{opacity:0\.000/);
});

test('reveal is monotonic in t (win increases)', () => {
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const p = win(t, 0.18, 0.46);
    assert.ok(p >= prev, `win should not decrease at t=${t}`);
    prev = p;
  }
});

test('a mid frame is partially revealed (between 0 and 1)', () => {
  const css = revealCss(0.3);
  const m = css.match(/\.headline\{opacity:([\d.]+)/);
  const o = parseFloat(m[1]);
  assert.ok(o > 0 && o < 1, `headline mid-opacity should be between 0 and 1, got ${o}`);
});

test('buildReelFrame reuses the card (right size, appends reveal style)', () => {
  const frame = buildReelFrame({ headline: 'Ship it', size: 'square' }, 0.5);
  assert.equal(frame.width, SIZES.square.w);
  assert.equal(frame.height, SIZES.square.h);
  assert.match(frame.html, /id="reel"/);
  assert.match(frame.html, /Ship it/);
});

test('buildReelFrame is deterministic for a given t', () => {
  const a = buildReelFrame({ headline: 'same' }, 0.42);
  const b = buildReelFrame({ headline: 'same' }, 0.42);
  assert.equal(a.html, b.html);
});

test('reel inherits the card theme + anti-slop (em dash stripped)', () => {
  const frame = buildReelFrame({ headline: 'fast — clean', theme: 'paper' }, 1);
  assert.ok(!frame.html.includes('—'), 'no em dash in a reel frame');
});

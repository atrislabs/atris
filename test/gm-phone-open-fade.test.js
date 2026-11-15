'use strict';

// How the page-open card fade is read, fed frames made by hand, so none of it
// needs Chrome. The real capture is in gm-phone-motion.test.js; this pins what
// the reading does with a slow frame, a cut that hides inside one, and a
// capture with too few frames to judge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readOpenFade } = require('../scripts/gm-phone-paths');

const show = x => JSON.stringify(x, null, 1);
const foot = { y: 800, o: 1 };

// the page's own fade: 300ms, ease-out (cubic-bezier 0, 0, 0.58, 1)
function ease(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bez = (p1, p2) => t => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  const x = bez(0, 0.58), y = bez(0, 1);
  let lo = 0, hi = 1;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (x(m) < p) lo = m; else hi = m; }
  return y((lo + hi) / 2);
}
const frame = (ft, card) => ({ t: ft, ft, card, foot });
// frames that follow the page's real fade, one gap after another; the fade starts at the first frame after fadeAt
function realFade(gaps, fadeAt = 3, duration = 300) {
  let ft = 1000, start = null;
  return [frame(ft, 0), ...gaps.map((g, i) => {
    ft += g;
    if (i === fadeAt) start = ft;
    return frame(ft, start === null ? 0 : ease((ft - start) / duration));
  })];
}
const steady = n => Array(n).fill(16.7);
// frames with the card at the given opacities, one gap apart
function samples(cards, gap, from = 1000) {
  return cards.map((c, i) => frame(from + i * gap, c));
}

test('open fade: a real fade at 60fps reads 0.09, with nothing left out and nothing reported', () => {
  const r = readOpenFade(realFade([...steady(3), ...steady(20), ...steady(5)]));
  assert.ok(r.card_fade > 0.05 && r.card_fade <= 0.15, show(r));
  assert.equal(r.unreliable, null, show(r));
  assert.deepEqual([r.stall_frames, r.cuts, r.big_steps], [0, [], []], show(r));
});

test('open fade: one slow frame in a real fade is a stall left out, not a jump or a cut', () => {
  // a 65ms frame in the steepest part of the fade: raw step past 0.3, but a fade can move that far in 65ms
  const r = readOpenFade(realFade([...steady(3), 16.7, 16.7, 65, ...steady(16), ...steady(5)]));
  assert.ok(r.card_fade_raw > 0.3, `the old check read the raw step: ${show(r)}`);
  assert.ok(r.card_fade <= 0.15, show(r));
  assert.equal(r.stall_frames, 1, show(r));
  assert.deepEqual(r.cuts, [], show(r));
  assert.equal(r.unreliable, null, show(r));
});

test('open fade: a cut across a 60ms frame is a cut, and so is the cut back', () => {
  // a normal fade with six samples between, then opacity 1 to 0 across 60ms and back to 1 across another 60ms
  const fade = samples([0, 0.14, 0.28, 0.42, 0.57, 0.71, 0.85, 1], 16.7);
  const end = fade[fade.length - 1].ft;
  const frames = [...fade, frame(end + 60, 0), frame(end + 120, 1)];
  const r = readOpenFade(frames);
  assert.ok(r.card_fade >= 0.9, show(r));
  assert.equal(r.cuts.length, 2, show(r));
  for (const c of r.cuts) assert.deepEqual([c.stalled, c.frame_ms], [true, 60], show(r));
  assert.deepEqual(r.cuts.map(c => [c.from, c.to]), [[1, 0], [0, 1]], show(r));
  assert.equal(r.card_fade_raw, 1, `the raw maximum includes stalled frames: ${show(r)}`);
  assert.equal(r.unreliable, null, show(r));
});

test('open fade: a card cut in one normal frame fails, and the cut is reported with its frame', () => {
  const r = readOpenFade(samples([0, 0, 0, 1, 1, 1, 1, 1, 1, 1], 16.7));
  assert.equal(r.card_fade, 1, show(r));
  assert.deepEqual(r.cuts.map(c => [c.from, c.to, c.frame_ms]), [[0, 1, 17]], show(r));
  // and with no fade to read there is no good capture either
  assert.match(r.unreliable, /0 fading frames/, show(r));
});

test('open fade: a capture made of stalls cannot pass, and says how many', () => {
  // six samples at 0.5, 60ms apart, then 1 after another 60ms: no step is big enough to be a cut
  const r = readOpenFade(samples([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1], 60));
  assert.equal(r.card_fade, 0, show(r));
  assert.deepEqual(r.cuts, [], show(r));
  assert.ok(r.unreliable, `an unreliable capture must not pass: ${show(r)}`);
  assert.match(r.unreliable, /6 of 6 frames while the card faded in were stalls/, show(r));
  assert.match(r.unreliable, /7 frames in all/, show(r));
});

test('open fade: over a quarter of the fade in stalls is unreliable, a quarter or less is not', () => {
  // a slower fade (500ms) so that plenty of frames are left whole; each stall is 55ms
  const withStalls = n => realFade([...steady(3), ...steady(3), ...Array(n).fill(55), ...steady(40)], 3, 500);
  const four = readOpenFade(withStalls(4));
  assert.equal(four.stall_frames, 4, show(four));
  assert.ok(four.stall_frames <= 0.25 * four.fade_frames, show(four));
  assert.equal(four.unreliable, null, show(four));
  const five = readOpenFade(withStalls(5));
  assert.equal(five.stall_frames, 5, show(five));
  assert.ok(five.stall_frames > 0.25 * five.fade_frames, show(five));
  assert.match(five.unreliable, new RegExp('^capture unreliable: 5 of ' + five.fade_frames + ' frames while the card faded in were stalls'), show(five));
});

test('open fade: fewer than 6 fading frames that were not stalls is unreliable', () => {
  // a fade that shows in 5 frames only
  const r = readOpenFade(samples([0, 0, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 1, 1, 1], 16.7));
  assert.match(r.unreliable, /and 5 fading frames were not \(6 needed\)/, show(r));
  assert.equal(readOpenFade(samples([0, 0, 0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.97, 1, 1], 16.7)).unreliable, null);
});

test('open fade: a page that never shows a card has no fade to be unreliable about', () => {
  const r = readOpenFade(samples([0, 0, 0, 0, 0], 16.7));
  assert.deepEqual([r.unreliable, r.card_fade, r.stall_frames], [null, 0, 0], show(r));
});

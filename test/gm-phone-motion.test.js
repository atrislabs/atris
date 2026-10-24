'use strict';

// Every way the orb moves, frame by frame, in headless Chrome through
// scripts/gm-phone-paths.js: an answer tapped or typed, a late answer, yes,
// no, not now, the small orb home, the big orb's tap, the team opened and
// closed, the deck flipped, and the calm line left. No jump, no cut, no
// frozen moment while something is on its way, and once a card lands
// nothing runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../scripts/gm-phone-paths');
const { findChrome } = require('../scripts/gm-phone-trace');

const CHROME = findChrome();
const skip = !CHROME && 'no chrome on this machine';
const byName = out => Object.fromEntries(out.paths.map(p => [p.name, p]));
const show = p => JSON.stringify(p, null, 1);

// a turn in place keeps the footer on screen while the card's height glides
const IN_PLACE = new Set(['deck flip']);

test('browser: every orb path glides, with no jump, no cut, and no frozen moment, and nothing runs once a card lands', { skip, timeout: 240000 }, async () => {
  const out = await paths.pathsTrace({ chromePath: CHROME });
  assert.equal(out.paths.length, paths.PATHS.length);
  for (const p of out.paths) {
    assert.equal(p.error, undefined, show(p));
    // only the beat the chosen answer holds is still
    assert.ok(p.longest_still_moving_ms <= 200, show(p));
    // per 60fps frame, css pixels, on each part's own clock
    assert.ok(p.lava_step <= 45 && p.lava_size_step <= 45 && p.lava_speed_change <= 15, show(p));
    assert.ok(p.sphere_step <= 10 && p.dots_speed_change <= 10 && p.title_step <= 5, show(p));
    // the footer moves only while it cannot be seen, or glides with a turn in place
    assert.ok(IN_PLACE.has(p.name) ? p.footer_seen_jump <= 20 : p.footer_seen_jump === 0, show(p));
    // after an act on a card the sphere comes back with no stale words under it
    if (p.starts !== 'big orb' && !['small orb home', 'calm line home'].includes(p.name)) assert.ok(!p.lines_while_moving.includes('tap to think'), show(p));
    // the card and the sphere fade, never vanish in a frame
    assert.ok(p.card_fade <= 0.3 && p.sphere_drop <= 0.3, show(p));
    if (p.lands) {
      // a second after the card lands: no dots drawn, no animation running
      assert.equal(p.after.orb_frames, 0, show(p));
      assert.deepEqual(p.after.running, [], show(p));
    } else {
      // back on the big orb the sphere drifts
      assert.ok(p.after.orb_frames > 20, show(p));
    }
  }
});

test('trace: a cut in the frames reads as a cut, and a fade as a fade', () => {
  const frame = (t, o, line) => ({ t, ft: t, orb: { frame: 0, mode: 'card', step: 0, mean: 0, ms: 16.7 }, sphere: 0, stage: null, lava: null, box: { o, card: 'c', title: { x: 0, y: 0, w: 10, h: 10 }, text: 'c' }, ghost: 0, line, foot: { r: { x: 0, y: 0, w: 10, h: 10 }, o: 1 }, busy: true });
  // twelve frames of a 0.2s fade
  const fading = Array.from({ length: 13 }, (_, i) => frame(i * 16.7, 1 - i / 12, null));
  const faded = paths.summarizePath(fading, 0);
  assert.ok(faded.card_fade < 0.1, show(faded));
  // the card gone in one frame
  const cut = paths.summarizePath([frame(0, 1, null), frame(16.7, 0, null)], 0);
  assert.equal(cut.card_fade, 1, show(cut));
  // a line that pops in reads as a cut, and its words are kept
  const popped = paths.summarizePath([frame(0, 0, null), frame(16.7, 0, { text: 'tap to think', o: 1 })], 0);
  assert.equal(popped.line_fade, 1, show(popped));
  assert.deepEqual(popped.lines_while_moving, ['tap to think']);
});

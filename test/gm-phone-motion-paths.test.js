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
  assert.equal(out.paths.length, paths.PATHS.length, show(out.paths.map(p => p.name)));
  for (const p of out.paths) {
    assert.equal(p.error, undefined, show(p));
    // only the beat the chosen answer holds is still
    assert.ok(p.longest_still_moving_ms <= 200, show(p));
    // per 60fps frame, css pixels, on each part's own clock
    assert.ok(p.lava_step <= 45 && p.lava_size_step <= 45 && p.lava_speed_change <= 15, show(p));
    assert.ok(p.sphere_step <= 10 && p.dots_speed_change <= 10 && p.title_step <= 5, show(p));
    // a turn in place is a crossfade with no blink: before, the two cards dipped to 0.41 together
    if (IN_PLACE.has(p.name)) assert.ok(p.crossfade_min >= 0.9, show(p));
    // the footer moves only while it cannot be seen, or glides with a turn in place
    assert.ok(IN_PLACE.has(p.name) ? p.footer_seen_jump <= 20 : p.footer_seen_jump === 0, show(p));
    // after an act on a card the sphere comes back with no stale words under it
    if (p.starts !== 'big orb' && !['small orb home', 'calm line home'].includes(p.name)) assert.ok(!p.lines_while_moving.includes('tap to think'), show(p));
    // the line under the orb fades in and out with the sphere, never there in one frame
    assert.ok(p.line_fade <= 0.15, show(p));
    // the card and the sphere fade, never vanish in a frame
    assert.ok(p.card_fade <= 0.3 && p.sphere_drop <= 0.3, show(p));
    if (p.lands) {
      // the card fades up while the lava eases into its spot, one motion, never after it stops
      // (before, the big orb's card came 82ms after the lava had stopped)
      if (p.lava_still_ms != null) assert.ok(p.card_in_ms < p.lava_still_ms, show(p));
      // a second after the card lands: no dots drawn, no animation running
      assert.equal(p.after.orb_frames, 0, show(p));
      assert.deepEqual(p.after.running, [], show(p));
    } else {
      // back on the big orb the sphere drifts
      assert.ok(p.after.orb_frames > 20, show(p));
    }
  }
});

test('browser: under reduced motion every path is plain fades: nothing travels, and the sphere and the footer are never gone or moved in a frame', { skip, timeout: 240000 }, async () => {
  const out = await paths.pathsTrace({ chromePath: CHROME, reduced: true });
  for (const p of out.paths) {
    assert.equal(p.error, undefined, show(p));
    // no travel: not the lava, not the sphere, not the dots
    assert.deepEqual([p.lava_step, p.sphere_step, p.title_step], [0, 0, 0], show(p));
    // before, a card that came while the sphere showed took it away in one frame, and the footer jumped 370px in sight
    assert.ok(p.card_fade <= 0.15 && p.sphere_drop <= 0.15, show(p));
    assert.equal(p.footer_seen_jump, 0, show(p));
    // the line's words fade out and in too, never change in a frame. A 0.2s
    // fade moves 0.083 a 60fps frame: 0.15 passes one step and fails two, as
    // when a timer emptied the words two steps before their fade had ended
    assert.ok(p.line_fade <= 0.15, show(p));
    if (p.lands) assert.deepEqual([p.after.orb_frames, p.after.running], [0, []], show(p));
  }
  // a flip is a fade out and in, never words swapped in one frame (before: no fade, the footer jumped 121px)
  const flip = byName(out)['deck flip'];
  assert.ok(flip.card_fade > 0 && flip.card_fade <= 0.15, show(flip));
});

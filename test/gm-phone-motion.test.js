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
  assert.deepEqual(popped.lines_while_moving, ['tap to think'], show(popped));
});

// The lava moves by the clock. Hosted runs on 2026-11-14 and 2026-11-15 failed
// the glide check with one 100ms frame and a lava step near 120px: six frames
// of a smooth motion, read as one jump. A step is read per frame of the time
// it took; a real jump still reads as one, in a stall or not.
test('trace: a smooth glide through a frame the machine held is not a jump, and a real jump still is', () => {
  const frame = (t, x) => ({ t, ft: t, orb: { frame: 0, mode: 'card', step: 0, mean: 0, ms: 16.7 }, sphere: 0, stage: null, lava: { r: { x, y: 100, w: 80, h: 80 }, o: 1, at: t }, box: null, ghost: 0, line: null, foot: { r: { x: 0, y: 0, w: 10, h: 10 }, o: 0 }, busy: true });
  // 10px per 60fps frame for 40 frames, at 16.7ms each, except where the machine held a frame
  const glide = (heldAt, heldMs, jumpAt = -1, jumpPx = 0) => {
    const out = [];
    let t = 0, x = 0;
    for (let i = 0; i < 40; i++) {
      const ms = i === heldAt ? heldMs : 16.7;
      t += ms;
      x += 10 * ms / 16.7 + (i === jumpAt ? jumpPx : 0);
      out.push(frame(t, x));
    }
    return paths.summarizePath(out, 0);
  };
  const smooth = glide(-1, 0);
  assert.ok(smooth.lava_step <= 10.01 && smooth.lava_speed_change <= 0.01, show(smooth));
  // the page held 100ms, as a busy runner does: before, this read as a 60px step and a 50px change of speed
  const held = glide(20, 100);
  assert.equal(held.max_frame_ms, 100, show(held));
  assert.ok(held.lava_step <= 10.01 && held.lava_speed_change <= 0.01, show(held));
  // a 200px jump in a frame of normal length
  const jump = glide(-1, 0, 20, 200);
  assert.ok(jump.lava_step > 45 && jump.lava_speed_change > 15, show(jump));
  // a 60px jump inside a 100ms frame reads as the 60px it went past the glide
  const hidden = glide(20, 100, 20, 60);
  assert.ok(hidden.lava_step > 45 && hidden.lava_step < 75, show(hidden));
  // the same for a jump inside a frame held two seconds
  const frozen = glide(20, 2000, 20, 60);
  assert.ok(frozen.lava_step > 45, show(frozen));
  // a held step with no steady frame beside it counts at its full size, as before
  const { readSteps } = require('../scripts/gm-phone-trace');
  assert.deepEqual(readSteps([null, { d: 60, ms: 100 }, null], 50), [null, 60, null]);
  assert.deepEqual(readSteps([{ d: 10, ms: 16.7 }, { d: 60, ms: 100 }, { d: 10, ms: 16.7 }], 50).map(Math.round), [10, 10, 10]);
});

// The frozen moment is read on the wall clock. The chosen answer holds for
// a planned 150ms beat, and the limit is 200ms. A frame the machine holds
// as that beat ends delays the timer that starts the next motion, so the
// still ran on by the held time: hosted runs on 2026-11-13 read 340ms and
// 398ms. Only a held frame at the end of a still can stretch it.
test('trace: a frame the machine holds as a still beat ends does not stretch the beat, and a still too long still reads as too long', () => {
  const frame = (t, x) => ({ t, ft: t, orb: { frame: 0, mode: 'card', step: 0, mean: 0, ms: 16.7 }, sphere: 0, stage: null, lava: null, box: { o: 1, card: 'c', title: { x, y: 0, w: 10, h: 10 }, text: 'c' }, ghost: 0, line: null, foot: { r: { x: 0, y: 0, w: 10, h: 10 }, o: 1 }, busy: true });
  // ten moving frames, a still beat of beatMs, ten moving frames. held: a
  // frame of heldMs at that many 60fps frames into the beat (-1 none), and
  // late: the beat runs on by that much, as when the hold delays its timer
  // bunch: after the held frame Chrome reads that many frames 2ms apart
  const beat = (beatMs, heldAt = -1, heldMs = 0, late = 0, bunch = 0) => {
    const out = [];
    let t = 0, x = 0;
    const push = () => out.push(frame(t, x));
    push();
    for (let i = 0; i < 10; i++) { t += 16.7; x += 2; push(); }
    let left = beatMs + late;
    for (let i = 0; left >= 16.7 || i <= heldAt; i++) {
      const ms = i === heldAt ? heldMs : 16.7;
      t += ms; left -= ms; push();
      if (i === heldAt) for (let j = 0; j < bunch; j++) { t += 2; left -= 2; push(); }
    }
    for (let i = 0; i < 10; i++) { t += 16.7; x += 2; push(); }
    return paths.summarizePath(out, 0);
  };
  const plain = beat(150);
  assert.ok(plain.longest_still_moving_ms >= 125 && plain.longest_still_moving_ms <= 170, show(plain));
  // the beat's last frame held 100ms and its timer ran that much late, as on
  // a busy runner: before, this read about 250ms and failed the 200ms check
  const held = beat(150, 8, 100, 90);
  assert.equal(held.max_frame_ms, 100, show(held));
  assert.ok(held.longest_still_moving_ms <= 200, show(held));
  // the same with two frames read 2ms apart after the hold, as the 'yes' path
  // read under a 100ms hold every 400ms: 233ms before
  const bunched = beat(150, 8, 100, 90, 2);
  assert.ok(bunched.max_frame_ms === 100 && bunched.longest_still_moving_ms <= 200, show(bunched));
  // a beat planned too long fails with no held frame, and with one inside it
  assert.ok(beat(260).longest_still_moving_ms > 200, show(beat(260)));
  const inside = beat(260, 5, 100);
  assert.ok(inside.max_frame_ms === 100 && inside.longest_still_moving_ms > 200, show(inside));
  // and with the held frame at its end
  const longHeld = beat(260, 14, 100, 90);
  assert.ok(longHeld.max_frame_ms === 100 && longHeld.longest_still_moving_ms > 200, show(longHeld));
});

// The quick bloom after an answer grows for 140ms, about eight frames. A
// frame the machine held 100ms on its first or second frame swallowed the
// fast middle of the growth: the page placed the lava by the clock, so the
// next frame drew it about 110px bigger, a jump on screen that the reader
// rightly saw (lava_size_step 62 to 172 against a limit of 45). The page
// holds the lava where it was through a held frame instead.
const HOLD_BLOOM = (ms, nth) => `(function () { var armed = true, n = 0; (function tick() { var lava = document.getElementById('lava'); if (lava) { var growing = lava.classList.contains('alive') && !lava.classList.contains('still') && getComputedStyle(lava).visibility !== 'hidden'; if (growing && armed) { n += 1; if (n === ${nth}) { armed = false; var t = performance.now(); while (performance.now() - t < ${ms}) {} } } else if (!growing) { armed = true; n = 0; } } requestAnimationFrame(tick); })(); })();`;
test('browser: a frame the machine holds early in the quick bloom draws no jump', { skip, timeout: 240000 }, async () => {
  for (const [ms, nth] of [[100, 1], [100, 2], [167, 1]]) {
    const p = byName(await paths.pathsTrace({ chromePath: CHROME, only: ['tapped answer'], before: HOLD_BLOOM(ms, nth) }))['tapped answer'];
    const said = `held ${ms}ms on bloom frame ${nth}\n${show(p)}`;
    assert.equal(p.error, undefined, said);
    assert.ok(p.max_frame_ms >= ms - 5, said);
    assert.ok(p.lava_step <= 45 && p.lava_size_step <= 45 && p.lava_speed_change <= 15, said);
    assert.ok(p.longest_still_moving_ms <= 200, said);
  }
});

test('browser: on a phone six times slower the sphere re-forms in about the same time as at full speed', { skip, timeout: 120000 }, async () => {
  const only = ['small orb home'];
  const fast = byName(await paths.pathsTrace({ chromePath: CHROME, only }))['small orb home'];
  const slow = byName(await paths.pathsTrace({ chromePath: CHROME, only, cpu: 6 }))['small orb home'];
  const both = show({ fast, slow });
  assert.ok(fast.reform_clock_ms > 200 && fast.reform_clock_ms < 900, both);
  // the springs run on time, not per frame: read on the dots' own clock, so a
  // stall the machine makes is left out, a slow phone took 1.5 times as long
  // before; now the same within a quarter
  assert.ok(slow.reform_clock_ms <= 1.25 * fast.reform_clock_ms, both);
});

test('browser: the big orb sets its fill color once a brightness level, not once a dot, and still draws every dot', { skip, timeout: 90000 }, async () => {
  const { onPhone, cardDesk } = require('../scripts/gm-phone-trace');
  // every fill color set and every dot drawn, counted from before the page runs
  const COUNT = "(function () { var P = CanvasRenderingContext2D.prototype, d = Object.getOwnPropertyDescriptor(P, 'fillStyle'), arc = P.arc; window.__draw = { styles: 0, arcs: 0 }; Object.defineProperty(P, 'fillStyle', { get: d.get, set: function (v) { window.__draw.styles += 1; d.set.call(this, v); }, configurable: true }); P.arc = function () { window.__draw.arcs += 1; return arc.apply(this, arguments); }; })();";
  const out = await onPhone(cardDesk(null, async () => ({ card: null })), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT });
    await send('Page.reload');
    await p.until("document.readyState === 'complete' && document.getElementById('line').textContent === 'tap to think'", 'the big orb');
    await new Promise(r => setTimeout(r, 600));
    return p.run("new Promise(function (done) { var o = document.getElementById('orb').__orb, f0 = o.frame, s0 = window.__draw.styles, a0 = window.__draw.arcs; var t0 = performance.now(); setTimeout(function () { var n = o.frame - f0, ms = performance.now() - t0; done({ frames: n, window_ms: Math.round(ms), frame_ms: Math.round(ms / Math.max(1, n)), styles: (window.__draw.styles - s0) / n, arcs: (window.__draw.arcs - a0) / n }); }, 1000); })");
  }, undefined, { firstCard: false });
  const said = show(out);
  assert.ok(out.frames > 20, said);
  // 5500 dots on a phone: before, 5500 color changes a frame; now at most one a level
  assert.ok(out.arcs > 4000, said);
  assert.ok(out.styles <= 130, said);
});

test('browser: a page that opens on a card shows the card fading in, never the big orb or its line first, and the footer never jumps', { skip, timeout: 90000 }, async () => {
  const { CARDS } = require('../scripts/gm-phone-trace');
  // a link with 250ms each way, as a phone on wifi can be
  const card = await paths.openTrace({ chromePath: CHROME, first: CARDS.b1, latency: 250 });
  const said = show(card);
  // before: 14 frames of the sphere bursting and 15 of "tap to think", then the card cut in and the footer jumped 370px
  assert.equal(card.sphere_frames_before_card, 0, said);
  assert.equal(card.line_frames_before_card, 0, said);
  assert.equal(card.footer_seen_jump, 0, said);
  // a capture made mostly of stalls shows too little of the fade to judge, so it cannot pass
  assert.equal(card.unreliable, null, `${card.unreliable}\n${said}`);
  assert.ok(card.card_frames_fading >= 6 && card.card_fade <= 0.15, said);
  assert.equal(card.dots_drawn, 0, said);
  // with no card the big orb starts and its line fades in
  const orb = await paths.openTrace({ chromePath: CHROME, first: null, latency: 250 });
  assert.ok(orb.dots_drawn > 20 && orb.line_at_end === 1 && orb.footer_seen_jump === 0, show(orb));
});

test('browser: turning the phone keeps the small orb centred over the card, and a resized window redraws the big orb sharp', { skip, timeout: 90000 }, async () => {
  const { LAPTOP } = require('../scripts/gm-phone-trace');
  // 390x844 turned to 844x390 with a card up: before, the small orb stayed 227px left of centre
  const turned = await paths.resizeTrace({ chromePath: CHROME });
  assert.equal(turned.before.orb_off_center_px, 0, show(turned));
  assert.ok(turned.after.vw === 844 && turned.after.orb_off_center_px <= 1, show(turned));
  // a laptop window made smaller: before, a 1040px canvas was shown at 432px
  const smaller = await paths.resizeTrace({ chromePath: CHROME, first: null, from: { ...LAPTOP, deviceScaleFactor: 2 }, to: { width: 900, height: 600, deviceScaleFactor: 2, mobile: false } });
  assert.ok(smaller.before.canvas_sharp && smaller.after.canvas_sharp, show(smaller));
  assert.notDeepEqual(smaller.after.canvas_shown, smaller.before.canvas_shown, show(smaller));
});

test('browser: turning a phone with the big orb up gives the sphere the dots its new size holds, every frame on the way draws it, and turning back brings the upright 5500 back', { skip, timeout: 90000 }, async () => {
  const { onPhone, cardDesk, PHONE } = require('../scripts/gm-phone-trace');
  const COUNT = "(function () { var P = CanvasRenderingContext2D.prototype, arc = P.arc; window.__arcs = 0; window.__frames = []; P.arc = function () { window.__arcs += 1; return arc.apply(this, arguments); }; (function tick() { window.__frames.push(window.__arcs); requestAnimationFrame(tick); })(); })();";
  const DRAWN = "new Promise(function (done) { var o = document.getElementById('orb').__orb, f0 = o.frame, a0 = window.__arcs; var t0 = performance.now(); setTimeout(function () { var n = o.frame - f0, ms = performance.now() - t0; done({ size: Math.round(document.getElementById('orb').getBoundingClientRect().width), per_frame: Math.round((window.__arcs - a0) / n), frames: n, window_ms: Math.round(ms), frame_ms: Math.round(ms / Math.max(1, n)) }); }, 500); })";
  const out = await onPhone(cardDesk(null, async () => ({ card: null })), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT });
    await send('Page.reload');
    await p.until("document.readyState === 'complete' && !document.body.classList.contains('opening') && document.getElementById('orb').__orb.frame > 2", 'the big orb');
    const upright = await p.run(DRAWN);
    const from = await p.run('window.__frames.length');
    // an iPhone 17 Pro turned on its side in Safari: 874 wide, 296 tall
    await send('Emulation.setDeviceMetricsOverride', { width: 874, height: 296, deviceScaleFactor: 3, mobile: true });
    await new Promise(r => setTimeout(r, 600));
    const side = await p.run(DRAWN);
    // every frame from the turn on drew dots
    const empty = await p.run(`(function () { var f = window.__frames, n = 0; for (var i = ${from} + 1; i < f.length; i++) if (f[i] === f[i - 1]) n += 1; return n; })()`);
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await new Promise(r => setTimeout(r, 600));
    return { upright, side, empty, back: await p.run(DRAWN) };
  }, undefined, { firstCard: false });
  const said = show(out);
  assert.equal(out.upright.per_frame, 5500, said);
  // before: the 96px orb on its side drew the laptop's 11000 dots, a solid orange ball
  assert.ok(out.side.per_frame < 5500 && out.side.per_frame / (out.side.size * out.side.size) <= 5500 / (230 * 230) * 1.02, said);
  assert.equal(out.empty, 0, said);
  assert.equal(out.back.per_frame, 5500, said);
});

test('browser: on a phone with a notch in full screen the small orb rests below the notch, as far above the card as anywhere', { skip, timeout: 90000 }, async () => {
  const plain = (await paths.resizeTrace({ chromePath: CHROME })).before;
  const notch = (await paths.resizeTrace({ chromePath: CHROME, insets: { top: 59, bottom: 34 } })).before;
  const said = show({ plain, notch });
  // before, the orb sat at 24px, under a 59px notch, while the card moved down below it
  assert.ok(notch.orb_top >= 59, said);
  assert.equal(notch.card_top - notch.orb_bottom, plain.card_top - plain.orb_bottom, said);
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

test('browser: in the background the page sends no looks and draws nothing, and back on screen it looks at once', { skip, timeout: 90000 }, async () => {
  const { CARDS } = require('../scripts/gm-phone-trace');
  for (const first of [null, CARDS.calm]) {
    const r = await paths.hiddenTrace({ chromePath: CHROME, first, holdMs: 6000 });
    // before: a look every 5 seconds on the big orb, five in 6 seconds on the calm line
    assert.deepEqual([r.looks_while_hidden, r.frames_while_hidden], [0, 0], show(r));
    assert.ok(r.look_after_ms !== null && r.look_after_ms < 100, show(r));
    // and the sphere picks up where it was
    assert.ok(r.frames_after > 10, show(r));
  }
});

test('browser: a flip the moment the page opens still fades the new card in from nothing, under the old one fading out', { skip, timeout: 90000 }, async () => {
  const first = paths.PATHS.find(s => s.name === 'deck flip').first;
  const r = await paths.openTrace({ chromePath: CHROME, first, latency: 0, flipAt: 0 });
  // before: the page-open fade held the new card at full strength under the old card's copy
  assert.equal(r.new_card_at_turn, 0, show(r));
  assert.ok(r.crossfade_min >= 0.9, show(r));
});

test('browser: with the pointer at any corner, the brightest dots are still drawn: every dot, every frame', { skip, timeout: 90000 }, async () => {
  const { onPhone, cardDesk, PHONE } = require('../scripts/gm-phone-trace');
  const COUNT = "(function () { var P = CanvasRenderingContext2D.prototype, arc = P.arc; window.__arcs = 0; P.arc = function () { window.__arcs += 1; return arc.apply(this, arguments); }; })();";
  const out = await onPhone(cardDesk(null, async () => ({ card: null })), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT });
    await send('Page.reload');
    await p.until("document.readyState === 'complete' && !document.body.classList.contains('opening')", 'the big orb');
    const seen = [];
    for (const [x, y] of [[0, 0], [PHONE.width - 1, 0], [0, PHONE.height - 1], [PHONE.width - 1, PHONE.height - 1]]) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      // the light eases toward the pointer; once there, count what each frame draws
      await new Promise(r => setTimeout(r, 1500));
      seen.push(await p.run("new Promise(function (done) { var o = document.getElementById('orb').__orb, f0 = o.frame, a0 = window.__arcs; var t0 = performance.now(); setTimeout(function () { var n = o.frame - f0, ms = performance.now() - t0; done({ frames: n, window_ms: Math.round(ms), frame_ms: Math.round(ms / Math.max(1, n)), per_frame: (window.__arcs - a0) / n }); }, 500); })"));
    }
    return seen;
  }, undefined, { firstCard: false });
  // a phone draws 5500 dots; before, a corner lit past the last brightness level and about 170 were left out
  for (const s of out) assert.ok(s.frames > 5 && s.per_frame === 5500, show(out));
});

test('browser: a first look for the card that stalls never leaves the page blank', { skip, timeout: 90000 }, async () => {
  const { CARDS } = require('../scripts/gm-phone-trace');
  // the first look hangs: the next look that comes back opens the page, with its card or the big orb
  const card = await paths.openTrace({ chromePath: CHROME, first: CARDS.b1, stall: 'first', latency: 0 });
  assert.ok(card.opened_ms !== null && card.opened_ms < 1000 && card.card_at_end === 1 && card.footer_at_end === 1, show(card));
  const orb = await paths.openTrace({ chromePath: CHROME, first: null, stall: 'first', latency: 0 });
  assert.ok(orb.opened_ms !== null && orb.opened_ms < 1000 && orb.dots_drawn > 20 && orb.line_at_end === 1, show(orb));
  // every look hangs, and the page came without its card (the desk could not read one):
  // the big orb opens after a short wait; before, the page stayed blank
  const { phonePage } = require('../lib/gm-phone-page');
  const none = await paths.openTrace({ chromePath: CHROME, first: CARDS.b1, stall: 'all', latency: 0, page: nonce => phonePage(nonce, null) });
  assert.ok(none.opened_ms !== null && none.opened_ms < 4000 && none.dots_drawn > 20 && none.footer_at_end === 1, show(none));
  // every look hangs, but the card came in the page: it is there at once, whole
  const held = await paths.openTrace({ chromePath: CHROME, first: CARDS.b1, stall: 'all', latency: 0 });
  assert.ok(held.opened_ms !== null && held.opened_ms < 1000 && held.card_at_end === 1 && held.footer_at_end === 1 && held.sphere_frames_before_card === 0, show(held));
});

// The first look's answer starts (a 200) but its words never finish, as on a
// link that drops mid-answer; the 4 second call-off lands while it is read.
const STALL_FIRST_BODY = `(function () {
  var real = window.fetch, looks = 0;
  window.fetch = function (url, opts) {
    if (String(url).indexOf('/card') < 0 || (opts && opts.method === 'POST') || looks++ > 0) return real.apply(this, arguments);
    var signal = opts && opts.signal;
    var body = new ReadableStream({ start: function (c) {
      c.enqueue(new TextEncoder().encode('{"ok":true,'));
      if (signal) signal.addEventListener('abort', function () { c.error(new DOMException('the look was called off', 'AbortError')); });
    } });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  };
})()`;

test('browser: a first look whose answer is cut off mid-read is no answer, so the next look\'s card still shows', { skip, timeout: 90000 }, async () => {
  const { onPhone, cardDesk, CARDS, PHONE } = require('../scripts/gm-phone-trace');
  const { phonePage } = require('../lib/gm-phone-page');
  const desk = cardDesk(CARDS.b1, async () => ({ card: CARDS.b1 }));
  // the page comes without its card, as when the desk could not read one
  const out = await onPhone(desk, CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: STALL_FIRST_BODY });
    await send('Page.reload', {});
    const shown = `document.readyState === 'complete' && document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1')) && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b1.title)}`;
    // the cut-off look is called off at 4s; the next look, about 5s on, has the card
    await p.until(shown, 'the card', 15000).catch(() => {});
    return p.run("(function () { var h = document.querySelector('#bet h1'); return { has_card: document.body.classList.contains('has-card'), title: h ? h.textContent : null, opening: document.body.classList.contains('opening'), line: document.getElementById('line').textContent }; })()");
  }, PHONE, { firstCard: false, page: nonce => phonePage(nonce, null) });
  assert.deepEqual([out.has_card, out.title, out.opening], [true, CARDS.b1.title, false], show(out));
});

#!/usr/bin/env node
'use strict';

// Every way the orb moves, frame by frame. Each path serves the real page
// through the real phone handler with a desk that speaks the one card
// contract, drives it with real taps and keys in headless Chrome, and
// records every frame of everything that can move: the dots, the sphere,
// the lava, the card and its title, the line under the orb, and the
// footer. From the owner's act to the page at rest it reports the biggest
// one-frame steps and changes of speed, every one-frame fade (a cut), the
// longest still moment while something is on its way, the words the line
// showed, and, a second after rest, whether anything still runs.
//
//   node scripts/gm-phone-paths.js                 every path, as json
//   node scripts/gm-phone-paths.js --reduced       the same under reduced motion
//   node scripts/gm-phone-paths.js --cpu 6         the same on a cpu six times slower
//   node scripts/gm-phone-paths.js --only yes,no   just these paths
//   require('./scripts/gm-phone-paths')            { pathsTrace, PATHS, summarizePath }
//
// One Chrome per run (through lib/headless-chrome.js, in gm-phone-trace's
// launch), a fresh server and page for each path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const phone = require('../lib/gm-phone');
const gmCard = require('../lib/gm-card');
const { phonePage } = require('../lib/gm-phone-page');
const { findChrome, launch, cardDesk, CARDS, PHONE } = require('./gm-phone-trace');

const TOKEN = 'p'.repeat(43);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function serve(desk, page = phonePage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-paths-'));
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: dir, token: TOKEN, hosts, loadView: () => ({}),
    runStep: async () => ({ code: 0, last_line: 'ok' }), writeTarget: () => true, snapshotTarget: () => () => true,
    logPath: path.join(dir, 'gm-phone-actions.jsonl'), page, makeBetDesk: () => desk,
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  return { url: `http://${base}/?t=${TOKEN}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }) };
}

function driver(send) {
  const run = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`page: ${out.exceptionDetails.exception ? out.exceptionDetails.exception.description : out.exceptionDetails.text}`);
    return out.result.value;
  };
  const until = async (expr, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await run(expr)) return; await wait(16); }
    throw new Error(`waited ${ms}ms for ${what}`);
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  // a tap on a selector, or on the button that reads these words
  const tap = async (sel, label) => {
    const r = await run(`(function () { var n = ${label == null ? `document.querySelector(${JSON.stringify(sel)})` : `Array.prototype.find.call(document.querySelectorAll(${JSON.stringify(sel)}), function (b) { return b.textContent === ${JSON.stringify(label)} && b.offsetParent; })`}; if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`nothing to tap at ${sel}${label == null ? '' : ` reading ${label}`}`);
    await click(r.x, r.y);
  };
  const key = async (name, code, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  };
  const type = text => send('Input.insertText', { text });
  return { run, until, tap, key, type };
}

// ---- the recorder: one row per frame ---------------------------------------------------

const PATH_RECORDER = `(function () {
  var T = window.__paths = { frames: [], marks: [], on: true };
  document.addEventListener('click', function () { T.marks.push({ what: 'tap', t: performance.now() }); }, true);
  document.addEventListener('keydown', function (e) { T.marks.push({ what: e.key, t: performance.now() }); }, true);
  function r(n) { if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
  (function rec(now) {
    if (!T.on) return;
    var canvas = document.getElementById('orb'), stage = document.getElementById('stage'), lava = document.getElementById('lava');
    var box = document.getElementById('bet'), foot = document.getElementById('foot'), line = document.getElementById('line');
    var o = canvas.__orb;
    var ss = getComputedStyle(stage), ls = getComputedStyle(lava), ln = getComputedStyle(line);
    var shown = ss.display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden';
    var lv = ls.visibility !== 'hidden' && Number(ls.opacity) > 0.01;
    var ghost = document.querySelector('.bet.ghost');
    T.frames.push({
      t: performance.now(),
      ft: typeof now === 'number' ? now : performance.now(),
      orb: { frame: o.frame, mode: o.mode, step: o.step, mean: o.mean, ms: o.ms },
      sphere: shown ? Number(ss.opacity) : 0,
      stage: shown && Number(ss.opacity) > 0.05 ? r(stage) : null,
      lava: lv ? { r: r(lava), o: Number(ls.opacity), at: lava.__at } : null,
      box: box.hidden ? null : { o: Number(getComputedStyle(box).opacity), card: box.getAttribute('data-card'), title: r(box.querySelector('h1')), text: (box.querySelector('h1') || {}).textContent || '' },
      ghost: ghost ? Number(getComputedStyle(ghost).opacity) : 0,
      line: ln.display !== 'none' && line.textContent ? { text: line.textContent, o: Number(ln.opacity) } : null,
      foot: { r: r(foot), o: Number(getComputedStyle(foot).opacity) },
      busy: document.body.hasAttribute('data-busy'),
    });
    requestAnimationFrame(rec);
  })();
})()`;

// a second after rest: how many frames the dots drew, and every animation still running
const AFTER_REST = `new Promise(function (done) {
  var o = document.getElementById('orb').__orb, f0 = o.frame;
  setTimeout(function () {
    done({
      orb_frames: o.frame - f0,
      running: document.getAnimations().filter(function (a) { return a.playState === 'running'; }).map(function (a) { var n = a.effect && a.effect.target; return (a.animationName || a.transitionProperty || 'animation') + (n ? ' on ' + (n.id || n.className) : ''); }),
      plan: document.body.getAttribute('data-reveal-plan'),
    });
  }, 1000);
})`;

// ---- the summary -----------------------------------------------------------------------

const near = (a, b, px = 0.25) => (!a && !b) || Boolean(a && b && Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.w - b.w) <= px && Math.abs(a.h - b.h) <= px);
const mid = a => (a ? { x: a.x + a.w / 2, y: a.y + a.h / 2 } : null);
const stepOf = (a, b) => (a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : 0);
const round = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const seen = f => (f.box ? f.box.o : 0);
const lineO = f => (f.line ? f.line.o : 0);
const lavaO = f => (f.lava ? f.lava.o : 0);

// From the act (from) to the last frame: steps and changes of speed per
// 60fps frame on the clock each part moves by, as the wait trace reads
// them, and the biggest change of opacity in one frame for the card, the
// sphere, the lava, and the line. A fade of 0.2s moves about 0.08 a frame;
// a cut moves 1. The machine's pace is its 75th percentile frame and a
// frame over twice that (50ms to 250ms) is a stall, counted at full size.
function summarizePath(frames, from) {
  const span = frames.filter(f => f.t >= from);
  const gaps = span.slice(1).map((f, i) => f.ft - span[i].ft).sort((x, y) => x - y);
  const pace = gaps.length ? gaps[Math.floor(0.75 * (gaps.length - 1))] : 16.7;
  const stall = Math.min(250, Math.max(50, 2 * pace));
  const per = ms => (ms > stall ? 1 : 16.7 / Math.max(8, ms));
  const out = { lava_step: 0, lava_size_step: 0, lava_speed_change: 0, sphere_step: 0, dots_step: 0, dots_speed_change: 0, title_step: 0, footer_seen_jump: 0, card_fade: 0, sphere_fade: 0, sphere_drop: 0, lava_fade: 0, line_fade: 0 };
  let prevLava = null, prevDots = null;
  let still = 0, stillAt = null, runStart = span.length ? span[0].t : 0;
  const cuts = [];
  const lines = [];
  for (let i = 1; i < span.length; i++) {
    const a = span[i - 1], b = span[i];
    const ms = b.ft - a.ft, k = per(ms);
    const dots = b.sphere > 0.05 && b.orb.frame > a.orb.frame && b.orb.mean > 0.12;
    const moved = dots || !near(a.stage, b.stage) || Math.abs(a.sphere - b.sphere) > 0.003
      || Boolean((a.lava || b.lava) && (!a.lava || !b.lava || !near(a.lava.r, b.lava.r) || Math.abs(a.lava.o - b.lava.o) > 0.004))
      || Math.abs(seen(a) - seen(b)) > 0.003 || Boolean(a.box && b.box && !near(a.box.title, b.box.title))
      || Math.abs(a.ghost - b.ghost) > 0.003 || Math.abs(lineO(a) - lineO(b)) > 0.003;
    if (moved) runStart = b.t;
    else if (b.busy && b.t - runStart > still) { still = b.t - runStart; stillAt = Math.round(runStart - from); }
    if (a.lava && b.lava && !(a.lava.at === b.lava.at && near(a.lava.r, b.lava.r))) {
      const own = a.lava.at != null && b.lava.at != null ? b.lava.at - a.lava.at : ms, kl = per(own);
      const st = stepOf(mid(a.lava.r), mid(b.lava.r)) * kl;
      out.lava_step = Math.max(out.lava_step, st);
      out.lava_size_step = Math.max(out.lava_size_step, Math.abs(a.lava.r.w - b.lava.r.w) * kl);
      if (prevLava) out.lava_speed_change = Math.max(out.lava_speed_change, Math.abs(st - prevLava.st) * per((prevLava.own + own) / 2));
      prevLava = { st, own };
    } else if (!a.lava || !b.lava) prevLava = null;
    if (a.stage && b.stage) out.sphere_step = Math.max(out.sphere_step, stepOf(a.stage, b.stage) * k, Math.abs(a.stage.w - b.stage.w) * k);
    if (b.orb.frame > a.orb.frame && a.sphere > 0.05 && b.sphere > 0.05) {
      const drawn = b.orb.frame - a.orb.frame, own = Math.max(8, b.orb.ms || 0);
      out.dots_step = Math.max(out.dots_step, b.orb.step * 16.7 / own);
      const speed = b.orb.mean * 16.7 / own;
      if (prevDots && drawn === 1) out.dots_speed_change = Math.max(out.dots_speed_change, Math.abs(speed - prevDots.speed) * 16.7 / ((prevDots.own + own) / 2));
      prevDots = drawn === 1 ? { speed, own } : null;
    } else prevDots = null;
    if (a.box && b.box && a.box.card === b.box.card && a.box.title && b.box.title) out.title_step = Math.max(out.title_step, stepOf(a.box.title, b.box.title) * k);
    if (stepOf(a.foot.r, b.foot.r) > 2 && Math.min(a.foot.o, b.foot.o) > 0.05) out.footer_seen_jump = Math.max(out.footer_seen_jump, stepOf(a.foot.r, b.foot.r));
    // a cut: what is seen changes all at once. The card under a still copy of
    // itself (a turn in place) is covered, and so is a sphere under the lava.
    // A stalled frame cannot tell a fade from a cut (a 0.2s fade moves half
    // its way in a 100ms frame), so it is not read for one.
    const at = Math.round(a.t - from);
    const fade = (what, x, y, covered) => {
      const d = covered || ms > stall ? 0 : Math.abs(x - y) * k;
      if (d > 0.3) cuts.push({ what, at_ms: at, from: round(x), to: round(y) });
      return d;
    };
    out.card_fade = Math.max(out.card_fade, fade('card', seen(a), seen(b), Math.max(a.ghost, b.ghost) > 0.5));
    const covered = Boolean((a.lava && a.lava.o > 0.5) || (b.lava && b.lava.o > 0.5));
    out.sphere_fade = Math.max(out.sphere_fade, fade('sphere', a.sphere, b.sphere, covered));
    if (!covered && a.sphere > b.sphere) out.sphere_drop = Math.max(out.sphere_drop, (a.sphere - b.sphere) * k);
    out.lava_fade = Math.max(out.lava_fade, fade('lava', lavaO(a), lavaO(b), false));
    out.line_fade = Math.max(out.line_fade, fade('line', lineO(a), lineO(b), false));
    if (b.busy && b.line && b.line.o > 0.05 && !lines.includes(b.line.text)) lines.push(b.line.text);
  }
  for (const k of Object.keys(out)) out[k] = round(out[k]);
  // the sphere re-forming out of the point: from the frame it is seen until
  // its dots slow under half a pixel per 60fps frame for good (the spring
  // swings back once), on the wall clock and on the dots' own clock (a stall
  // the machine makes is not the motion's)
  const born = span.findIndex((f, i) => i > 0 && f.sphere > 0.05 && span[i - 1].sphere <= 0.05);
  let formed = -1;
  for (let i = born + 1; born > 0 && i < span.length && span[i].t - span[born].t < 1500; i++) {
    if (span[i].orb.frame > span[i - 1].orb.frame && span[i].orb.mean * 16.7 / Math.max(8, span[i].orb.ms || 0) >= 0.5) formed = Math.min(span.length - 1, i + 1);
  }
  // when the next card first shows, and when the lava last moved: a card that
  // comes in as the lava eases into its spot overlaps it
  const before = span.length ? span[0].box && span[0].box.card : null;
  const cardIn = span.findIndex(f => f.box && f.box.card !== before && f.box.o > 0.02);
  let lavaLast = -1;
  for (let i = 1; i < span.length; i++) if (span[i].lava && span[i - 1].lava && !near(span[i].lava.r, span[i - 1].lava.r)) lavaLast = i;
  let clock = 0;
  for (let i = born + 1; formed > 0 && i <= formed; i++) if (span[i].orb.frame > span[i - 1].orb.frame) clock += span[i].orb.ms || 0;
  return {
    ms: span.length ? Math.round(span[span.length - 1].t - from) : null,
    pace_frame_ms: Math.round(pace),
    longest_still_moving_ms: Math.round(still),
    longest_still_at_ms: stillAt,
    reform_ms: formed < 0 ? null : Math.round(span[formed].t - span[born].t),
    reform_clock_ms: formed < 0 ? null : Math.round(clock),
    card_in_ms: cardIn < 0 ? null : Math.round(span[cardIn].t - from),
    lava_still_ms: lavaLast < 0 ? null : Math.round(span[lavaLast].t - from),
    ...out,
    cuts: cuts.slice(0, 12),
    // the words the line under the orb showed while something was on its way
    lines_while_moving: lines,
  };
}

// ---- the paths ---------------------------------------------------------------------------

const ACK = 'builder has it and is starting now.';
const TEAM_ROWS = [{ member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: the getting started page, about 4 hours left' }];
const team = n => gmCard.team({ id: `team~${n}`, rows: TEAM_ROWS });
const DECK_JOBS = [
  { job_id: 'm-nav', mission_id: 'm-nav', member: 'navigator', label: 'needs you', time: 'waiting 2 hours', rows: [{ work: 'plan the pricing page', member: 'navigator', role: 'system navigator', status: 'needs you' }], yes: { key: 'm-nav:1', hash: 'abc', what: 'navigator wants to publish the pricing page', why: 'navigator is waiting on your yes for this.' } },
  { job_id: 'm-b2', mission_id: 'm-b2', member: 'builder', label: 'working', time: 'about 4 hours left', rows: [{ work: 'split the big test file', member: 'builder', role: 'builder', status: 'working' }] },
];
const deck = (at, n) => { const c = DECK_JOBS[at]; return gmCard.deck({ id: `deck~${n}`, at, total: DECK_JOBS.length, card: c, columns: ['work', 'member', 'role', 'status'], job: { member: c.member, role: c.rows[0].role } }); };

// the page at rest on this card, or with no card on the big orb
const restOn = title => `!document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card') && document.getElementById('bet').classList.contains('up') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning') && Boolean(document.querySelector('#bet h1')) && document.querySelector('#bet h1').textContent === ${JSON.stringify(title)}`;
const HOME = "!document.body.hasAttribute('data-busy') && !document.body.classList.contains('has-card')";
const READY = "!document.body.hasAttribute('data-busy') && (document.body.classList.contains('has-card') ? document.getElementById('bet').classList.contains('up') : document.getElementById('line').textContent === 'tap to think')";

// Each path: the card it opens on (null: the big orb), how its desk answers,
// the owner's act, and the page at rest after it. lands: a card is up at
// the end, so nothing may still run.
const PATHS = [
  { name: 'tapped answer', first: CARDS.q1, on: () => ({ card: CARDS.b1 }), act: p => p.tap('#bet .choice'), rest: restOn(CARDS.b1.title), lands: true },
  { name: 'typed answer', first: CARDS.q1, on: () => ({ card: CARDS.b1 }), act: async (p) => { await p.tap('#bet .choice.other'); await wait(250); await p.type('paying schools'); await p.key('Enter', 13, '\r'); }, rest: restOn(CARDS.b1.title), lands: true },
  { name: 'a late answer', first: CARDS.q1, on: async () => { await wait(1200); return { card: CARDS.b1 }; }, act: p => p.tap('#bet .choice'), rest: restOn(CARDS.b1.title), lands: true },
  { name: 'yes', first: CARDS.yes, on: () => ({ card: CARDS.b2, ack: ACK }), act: async (p) => { await p.tap('#bet button', 'yes'); await wait(200); await p.tap('#bet button', 'tap again to say yes'); }, rest: restOn(CARDS.b2.title), lands: true },
  { name: 'no', first: CARDS.yes, on: () => ({ card: CARDS.b2 }), act: p => p.tap('#bet button', 'no'), rest: restOn(CARDS.b2.title), lands: true },
  { name: 'not now', first: CARDS.b1, on: () => ({ card: null, home: true }), act: p => p.tap('#bet button', 'not now'), rest: HOME, tail: 1200 },
  { name: 'small orb home', first: CARDS.b1, on: (a, n, { card }) => ({ card }), act: p => p.tap('#lava'), rest: HOME, tail: 600 },
  { name: 'big orb to card', first: null, on: () => ({ card: CARDS.b1 }), act: p => p.tap('#orb'), rest: restOn(CARDS.b1.title), lands: true },
  { name: 'team open', first: CARDS.b1, on: (action, n) => ({ card: action === 'open:team' ? team(n) : CARDS.b1 }), act: p => p.tap('#working'), rest: restOn('the team'), lands: true },
  { name: 'team close with esc', first: team(1), on: () => ({ card: CARDS.b1 }), act: p => p.key('Escape', 27), rest: restOn(CARDS.b1.title), lands: true },
  { name: 'team from the big orb', first: null, on: (action, n) => ({ card: team(n) }), act: p => p.tap('#working'), rest: restOn('the team'), lands: true },
  { name: 'deck flip', first: deck(0, 1), on: (action, n) => ({ card: deck(action === 'flip' ? 1 : 0, n) }), act: p => p.key('ArrowRight', 39), rest: restOn(DECK_JOBS[1].rows[0].work), lands: true },
  { name: 'calm line home', first: CARDS.calm, on: (a, n, { card }) => ({ card }), act: p => p.tap('#orb'), rest: HOME, ready: "document.body.classList.contains('waiting') && !document.body.hasAttribute('data-busy')", tail: 1200 },
];

// One path in an open Chrome: a fresh server and page, settled first, then
// the act and every frame to rest.
async function runPath(send, spec, { cpu = 1, page = phonePage } = {}) {
  let n = 1;
  const desk = cardDesk(spec.first, async (action, ctx) => { n += 1; return spec.on(action, n, ctx); });
  const server = await serve(desk, page);
  const p = driver(send);
  try {
    await send('Page.navigate', { url: server.url });
    await p.until(`document.readyState === 'complete' && Boolean(document.getElementById('orb') && document.getElementById('orb').__orb) && (${spec.ready || READY})`, `${spec.name}: the first screen`);
    await wait(spec.first && spec.first.kind === 'wait' ? 700 : 300);
    if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await p.run(PATH_RECORDER);
    await wait(60);
    await spec.act(p);
    await p.until(spec.rest, `${spec.name}: the page at rest`, 15000);
    await wait(spec.tail || 300);
    await p.run('window.__paths.on = false');
    const frames = await p.run('window.__paths.frames');
    const marks = await p.run('window.__paths.marks');
    const after = await p.run(AFTER_REST);
    if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return { name: spec.name, starts: spec.first ? spec.first.kind : 'big orb', lands: Boolean(spec.lands), ...summarizePath(frames, marks.length ? marks[marks.length - 1].t : frames[0].t), after };
  } finally {
    await server.close();
  }
}

// Every path (or only the named ones), in one Chrome at phone size.
// page: another build of the page, for a before and after
async function pathsTrace({ chromePath = findChrome(), reduced = false, cpu = 1, only = null, viewport = PHONE, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const specs = only ? PATHS.filter(s => only.includes(s.name)) : PATHS;
  const chrome = await launch(chromePath);
  try {
    const { send } = chrome;
    await send('Emulation.setDeviceMetricsOverride', viewport);
    if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.enable');
    const out = [];
    for (const spec of specs) {
      try { out.push(await runPath(send, spec, { cpu, page })); } catch (err) { out.push({ name: spec.name, error: err.message }); }
    }
    return { reduced, cpu, viewport: `${viewport.width}x${viewport.height}`, paths: out };
  } finally {
    chrome.close();
  }
}

// ---- the page opening -------------------------------------------------------------------

// From the first frame the page draws to a second after it has settled, on
// a link this slow (ms each way): the frames the sphere or its line showed
// before the card, how far the footer moved while seen, and how many frames
// the card took to fade in. first: the card on screen, or null for the big orb.
const OPEN_RECORDER = `(function () {
  var T = window.__open = [];
  (function rec() {
    var canvas = document.getElementById('orb'), box = document.getElementById('bet'), foot = document.getElementById('foot'), line = document.getElementById('line');
    if (canvas && canvas.__orb && box && foot) {
      var stage = getComputedStyle(document.getElementById('stage')), ln = getComputedStyle(line), fb = foot.getBoundingClientRect();
      T.push({ t: performance.now(), dots: canvas.__orb.frame, sphere: stage.display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden', line: ln.display !== 'none' && Boolean(line.textContent) ? Number(ln.opacity) : 0, card: document.body.classList.contains('has-card') && !box.hidden ? Number(getComputedStyle(box).opacity) : 0, foot: { y: fb.top, o: Number(getComputedStyle(foot).opacity) } });
    }
    requestAnimationFrame(rec);
  })();
})();`;

async function openTrace({ chromePath = findChrome(), first = CARDS.b1, latency = 250, reduced = false, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serve(cardDesk(first, async (a, { card }) => ({ card })), page);
  const chrome = await launch(chromePath);
  try {
    const { send } = chrome;
    const p = driver(send);
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: OPEN_RECORDER });
    await send('Page.navigate', { url: server.url });
    await p.until(`document.readyState === 'complete' && (${READY})`, 'the page open', 15000);
    await wait(1000);
    const frames = await p.run('window.__open');
    const at = frames.findIndex(f => f.card > 0);
    const before = at < 0 ? frames : frames.slice(0, at);
    let footJump = 0, cardFade = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      if (Math.abs(a.foot.y - b.foot.y) > 2 && Math.min(a.foot.o, b.foot.o) > 0.05) footJump = Math.max(footJump, Math.abs(a.foot.y - b.foot.y));
      cardFade = Math.max(cardFade, Math.abs(a.card - b.card));
    }
    const shown = frames.filter(f => f.dots > 0 || f.sphere);
    return {
      first: first ? first.kind : 'big orb',
      frames: frames.length,
      sphere_frames_before_card: at < 0 ? null : before.filter(f => f.sphere && f.dots > 0).length,
      line_frames_before_card: at < 0 ? null : before.filter(f => f.line > 0.05).length,
      card_frames_fading: frames.filter(f => f.card > 0.02 && f.card < 0.98).length,
      card_fade: Math.round(cardFade * 100) / 100,
      footer_seen_jump: Math.round(footJump * 10) / 10,
      dots_drawn: shown.length ? frames[frames.length - 1].dots : 0,
      line_at_end: frames.length ? frames[frames.length - 1].line : 0,
    };
  } finally {
    chrome.close();
    await server.close();
  }
}

// ---- a turned phone and a resized window ---------------------------------------------------

// The page at rest at one size, then at another: where the small orb sits
// against the middle of the screen with a card up, and whether the big orb's
// canvas holds as many pixels as it is shown at with no card.
const AT_REST = `(function () {
  var l = document.getElementById('lava').getBoundingClientRect(), c = document.getElementById('orb'), dpr = Math.min(window.devicePixelRatio || 1, 2);
  var box = document.getElementById('bet'), first = box.hidden ? null : box.firstElementChild;
  return { orb_top: Math.round(l.top), orb_bottom: Math.round(l.bottom), card_top: first ? Math.round(first.getBoundingClientRect().top) : null, vw: document.documentElement.clientWidth, orb_off_center_px: Math.round(Math.abs(l.left + l.width / 2 - document.documentElement.clientWidth / 2) * 10) / 10, canvas_shown: [c.clientWidth, c.clientHeight], canvas_pixels: [c.width, c.height], canvas_sharp: Math.abs(c.width - c.clientWidth * dpr) <= 1 && Math.abs(c.height - c.clientHeight * dpr) <= 1 };
})()`;

// insets: the phone's safe area ({ top, bottom }), as on a phone with a notch in full screen
async function resizeTrace({ chromePath = findChrome(), first = CARDS.b1, from = PHONE, to = { ...PHONE, width: PHONE.height, height: PHONE.width }, insets = null, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serve(cardDesk(first, async (a, { card }) => ({ card })), page);
  const chrome = await launch(chromePath);
  try {
    const { send } = chrome;
    const p = driver(send);
    await send('Emulation.setDeviceMetricsOverride', from);
    if (insets) await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: insets.top || 0, topMax: insets.top || 0, bottom: insets.bottom || 0, bottomMax: insets.bottom || 0 } });
    await send('Page.enable');
    await send('Page.navigate', { url: server.url });
    await p.until(`document.readyState === 'complete' && (${READY})`, 'the page at rest');
    await wait(400);
    const before = await p.run(AT_REST);
    await send('Emulation.setDeviceMetricsOverride', to);
    await wait(700);
    return { first: first ? first.kind : 'big orb', before, after: await p.run(AT_REST) };
  } finally {
    chrome.close();
    await server.close();
  }
}

// ---- the page in the background --------------------------------------------------------------

// The page told it is hidden (as a phone does when another app comes up,
// or a laptop when another tab does) for holdMs, then shown again: the
// looks it sent to the Mac and the frames the orb drew while hidden, and
// how soon after it came back it looked again. first: the card it opens
// on, or null for the big orb.
const HIDE = `(function () {
  var hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return hidden; } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return hidden ? 'hidden' : 'visible'; } });
  var real = window.fetch, looks = window.__looks = [];
  window.fetch = function (url) { looks.push({ t: performance.now(), url: String(url).split('?')[0] }); return real.apply(this, arguments); };
  window.__hide = function (v) { hidden = v; window.__hiddenAt = performance.now(); document.dispatchEvent(new Event('visibilitychange')); };
})();`;

async function hiddenTrace({ chromePath = findChrome(), first = null, holdMs = 6000, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serve(cardDesk(first, async (a, { card }) => ({ card })), page);
  const chrome = await launch(chromePath);
  try {
    const { send } = chrome;
    const p = driver(send);
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE });
    await send('Page.navigate', { url: server.url });
    await p.until(`document.readyState === 'complete' && (${READY})`, 'the page at rest');
    await wait(500);
    const at = await p.run("(function () { window.__hide(true); return { t: performance.now(), frame: document.getElementById('orb').__orb.frame, looks: window.__looks.length }; })()");
    await wait(holdMs);
    const back = await p.run("(function () { var r = { t: performance.now(), frame: document.getElementById('orb').__orb.frame, looks: window.__looks.length }; window.__hide(false); return r; })()");
    await wait(600);
    const end = await p.run("({ frame: document.getElementById('orb').__orb.frame, looks: window.__looks.slice() })");
    const next = end.looks.slice(back.looks).find(l => l.t >= back.t);
    return {
      first: first ? first.kind : 'big orb',
      hidden_ms: Math.round(back.t - at.t),
      looks_while_hidden: back.looks - at.looks,
      frames_while_hidden: back.frame - at.frame,
      look_after_ms: next ? Math.round(next.t - back.t) : null,
      frames_after: end.frame - back.frame,
    };
  } finally {
    chrome.close();
    await server.close();
  }
}

module.exports = { pathsTrace, summarizePath, openTrace, resizeTrace, hiddenTrace, PATHS, PATH_RECORDER };

if (require.main === module) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  pathsTrace({ reduced: process.argv.includes('--reduced'), cpu: Number(arg('--cpu') || 1), only: arg('--only') ? arg('--only').split(',') : null })
    .then(out => process.stdout.write(JSON.stringify(out, null, 2) + '\n'), (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}

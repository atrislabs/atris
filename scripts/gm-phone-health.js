#!/usr/bin/env node
'use strict';

// Health traces of the gm phone page: how it opens, how it holds up over a
// long session, how it reads to a screen reader and at 200% zoom, and what
// it does when the Mac sleeps or the server stops. Each one serves the real
// page through the real phone handler (scripts/gm-phone-trace.js onPhone),
// puts a probe in the page before the page's own script runs, keeps every
// console line Chrome reports, and reads numbers back. Chrome starts through
// lib/headless-chrome.js, by way of the trace's launch.
//
//   node scripts/gm-phone-health.js --paint     first paint, on a slow link and a slowed cpu
//   node scripts/gm-phone-health.js --head      the home screen tags and icons, as the page has them
//   node scripts/gm-phone-health.js --reader    what a screen reader hears as cards land, a refused tap, the landmarks
//   node scripts/gm-phone-health.js --focus     each Tab stop on a card and the big orb, and its ring on screen
//   node scripts/gm-phone-health.js --zoom      the big orb and five cards at 200% zoom on two phones and a laptop
//   node scripts/gm-phone-health.js --long 100  100 cards in a row through every kind of move, and what the page holds after each round
//   node scripts/gm-phone-health.js --asleep    the Mac asleep under a card and the calm line
//   require('./scripts/gm-phone-health')        the traces, for tests

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const phone = require('../lib/gm-phone');
const { phonePage } = require('../lib/gm-phone-page');
const trace = require('./gm-phone-trace');
const gmCard = require('../lib/gm-card');

const TOKEN = 'h'.repeat(43);

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the probe: in the page before its own script -------------------------------------

// What the page did from its first moment: each paint, each layout shift,
// and one row per animation frame for the first FRAMES frames saying what
// was on screen then (a card, or the big orb with its line).
const FRAMES = 90;
const PROBE = `(function () {
  var P = window.__health = { paints: [], shifts: [], frames: [], asks: { out: {}, most: {} } };
  // every ask to the Mac, by method and path: how many are out now, and the most at once
  var fetch0 = window.fetch;
  window.fetch = function (url, opts) {
    var key = ((opts && opts.method) || 'GET') + ' ' + String(url).replace(/[?].*/, '');
    var a = P.asks;
    a.out[key] = (a.out[key] || 0) + 1;
    a.most[key] = Math.max(a.most[key] || 0, a.out[key]);
    var back = function () { a.out[key] -= 1; };
    return fetch0.apply(window, arguments).then(function (r) { back(); return r; }, function (e) { back(); throw e; });
  };
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { P.paints.push({ name: e.name, t: e.startTime }); }); }).observe({ type: 'paint', buffered: true }); } catch (e) { /* no paint timing */ }
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        P.shifts.push({ value: e.value, t: e.startTime, input: e.hadRecentInput, what: (e.sources || []).map(function (s) { return s.node ? (s.node.id || String(s.node.className || s.node.nodeName)) : 'gone'; }) });
      });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* no layout shift timing */ }
  // every timer, interval, and frame the page has waiting, and every canvas it makes
  var timers = { intervals: new Set(), timeouts: new Set(), frames: new Set(), canvases: 0 };
  var si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout, ra = window.requestAnimationFrame, ca = window.cancelAnimationFrame;
  window.setInterval = function () { var id = si.apply(window, arguments); timers.intervals.add(id); return id; };
  window.clearInterval = function (id) { timers.intervals.delete(id); return ci.call(window, id); };
  window.setTimeout = function (fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var id = st.call(window, function () { timers.timeouts.delete(id); if (typeof fn === 'function') fn.apply(window, rest); }, ms);
    timers.timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) { timers.timeouts.delete(id); return ct.call(window, id); };
  window.requestAnimationFrame = function (fn) { var id = ra.call(window, function (t) { timers.frames.delete(id); fn(t); }); timers.frames.add(id); return id; };
  window.cancelAnimationFrame = function (id) { timers.frames.delete(id); return ca.call(window, id); };
  var make = document.createElement;
  document.createElement = function (tag) { if (String(tag).toLowerCase() === 'canvas') timers.canvases += 1; return make.apply(document, arguments); };
  P.counts = function () {
    return { intervals: timers.intervals.size, timeouts: timers.timeouts.size, frames: timers.frames.size, canvases_made: timers.canvases, canvases: document.querySelectorAll('canvas').length, nodes: document.getElementsByTagName('*').length, copies: document.querySelectorAll('.bet.ghost').length };
  };
  // from the page's own first frame on, read after the page has drawn it:
  // the page asks for its frames first, so these come after them in each frame
  var n = 0;
  function look(t) {
    var body = document.body, box = document.getElementById('bet'), canvas = document.getElementById('orb');
    if (body && box && canvas) {
      P.frames.push({
        t: t,
        card: body.classList.contains('has-card') && !box.hidden,
        title: box.querySelector('h1') ? box.querySelector('h1').textContent : null,
        line: document.getElementById('line').textContent,
        dots: Boolean(canvas.__orb && canvas.__orb.frame > 0) && getComputedStyle(canvas).visibility !== 'hidden' && getComputedStyle(document.getElementById('stage')).display !== 'none',
      });
    }
    if (++n < ${FRAMES}) requestAnimationFrame(look);
  }
  document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(look); });
})()`;

// ---- the page, opened fresh with the probe in it ---------------------------------------

// Chrome's own reports that a person would see in the console: errors and
// warnings from the page, uncaught errors, and refused or failed loads.
function consoleLine(m) {
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    return { kind: 'uncaught', text: (d.exception && d.exception.description) || d.text || 'an error' };
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) {
    return { kind: m.params.type, text: (m.params.args || []).map(a => (a.value != null ? String(a.value) : a.description || '')).join(' ') };
  }
  if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
    return { kind: m.params.entry.level, text: m.params.entry.text, url: (m.params.entry.url || '').replace(/\?.*/, '') };
  }
  return null;
}

// The real phone handler over http with this desk, on a port that stays
// the same across a stop and a start. sleep(): the Mac takes connections
// and never answers (it went to sleep mid-session); wake() answers what it
// held. stop() and start(): the server quits and comes back.
async function serveDesk(desk, page = phonePage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-health-'));
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: dir, token: TOKEN, hosts, loadView: () => ({}), runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true, snapshotTarget: () => () => true, logPath: path.join(dir, 'gm-phone-actions.jsonl'), page, makeBetDesk: () => desk,
  });
  const answer = (q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); };
  let asleep = false;
  const held = [];
  const seen = [];
  const server = http.createServer((q, s) => { seen.push(`${q.method} ${q.url.replace(/\?.*/, '')}`); if (asleep) { held.push([q, s]); return; } answer(q, s); });
  const listen = port => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  await listen(0);
  const port = server.address().port;
  hosts.push(`127.0.0.1:${port}`);
  let up = true;
  const stop = () => new Promise(r => { if (!up) { r(); return; } up = false; server.closeAllConnections(); server.close(() => r()); });
  return {
    url: `http://127.0.0.1:${port}/?t=${TOKEN}`,
    seen,
    held,
    sleep: () => { asleep = true; },
    wake: () => { asleep = false; for (const [q, s] of held.splice(0)) answer(q, s); },
    stop,
    start: async () => { if (!up) { await listen(port); up = true; } },
    close: async () => { asleep = false; held.splice(0); await stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// chrome, retried once: with several traces running at once a start can time out
async function launchOnce(chromePath) {
  try { return await trace.launch(chromePath); } catch (err) {
    if (!/did not start/.test(err.message)) throw err;
    return trace.launch(chromePath);
  }
}

// The real page with this desk, opened with the probe in it from the first
// moment. latency: ms each request waits on the way (a phone on wifi); cpu:
// how many times slower the cpu runs (1 is this machine). fn(p, send, said,
// server) drives it; said is every console line so far.
async function openPage(desk, fn, { chromePath = trace.findChrome(), viewport = trace.PHONE, reduced = false, latency = 0, cpu = 1, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serveDesk(desk, page);
  let chrome = null;
  try {
    chrome = await launchOnce(chromePath);
    const { send } = chrome;
    const said = [];
    send.on((m) => { const line = consoleLine(m); if (line) said.push(line); });
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', viewport);
    if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (latency) await send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
    if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await send('Page.navigate', { url: server.url });
    const p = driver(send);
    await p.until("document.readyState === 'complete' && Boolean(window.__health)", 'the page to open', 15000);
    return await fn(p, send, said, server);
  } finally {
    if (chrome) chrome.close();
    await server.close();
  }
}

// run an expression in the page; wait for one to hold; tap what one finds
function driver(send) {
  const run = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`page: ${out.exceptionDetails.exception ? out.exceptionDetails.exception.description : out.exceptionDetails.text}`);
    return out.result.value;
  };
  const until = async (expr, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await run(expr)) return; await wait(20); }
    throw new Error(`waited ${ms}ms for ${what}`);
  };
  // find: an expression for the node, in the page
  const tap = async (find, what) => {
    const r = await run(`(function () { var n = ${find}; if (!n) return null; n.scrollIntoView({ block: 'center' }); var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (!r) throw new Error(`nothing to tap: ${what}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  // the button on the card that reads these words
  const button = words => `Array.prototype.find.call(document.querySelectorAll('#bet button, .foot button'), function (b) { return b.textContent === ${JSON.stringify(words)} && b.getBoundingClientRect().width > 0; })`;
  const tapButton = words => tap(button(words), `the button "${words}"`);
  return { run, until, tap, tapButton };
}

// at rest: no motion under way, and a card up and faded in
const AT_REST = "!document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card') && !document.getElementById('bet').hidden && document.getElementById('bet').classList.contains('up') && !document.querySelector('.bet.ghost')";
const titled = t => `${AT_REST} && Boolean(document.querySelector('#bet h1')) && document.querySelector('#bet h1').textContent === ${JSON.stringify(t)}`;

// ---- first paint ---------------------------------------------------------------------

// The page opened with a card already up on the Mac (card) or none (null).
// first_paint_ms: when anything was first painted; first_frame: what the
// first frame showed (the card, or the big orb with the dots); orb_frames_
// before_card: frames that showed the big orb while the Mac had a card up.
async function firstPaintTrace({ card = trace.CARDS.b1, latency = 120, cpu = 1, ...opts } = {}) {
  const desk = trace.cardDesk(card, async () => ({ card }));
  return openPage(desk, async (p, send, said) => {
    const ready = card ? "document.body.classList.contains('has-card') && !document.body.hasAttribute('data-busy')" : "document.getElementById('orb').__orb.frame > 2";
    await p.until(ready, 'the first look', 15000);
    // long enough for the probe's frames to run out, so the frame pace reads a full second and more
    await wait(card ? 600 : 2200);
    const h = await p.run('window.__health');
    const bytesAt = await p.run("performance.getEntriesByType('navigation')[0].responseEnd");
    const fcp = h.paints.find(x => x.name === 'first-contentful-paint');
    const shown = h.frames;
    const first = shown[0] || null;
    const cardAt = shown.findIndex(f => f.card);
    return {
      latency_ms: latency,
      cpu,
      first_paint_ms: fcp ? Math.round(fcp.t) : null,
      // from the page's last byte to its first paint: the page's own work, with the link taken out
      paint_after_bytes_ms: fcp ? Math.round(fcp.t - bytesAt) : null,
      first_frame: first ? { card: first.card, title: first.title, dots: first.dots, line: first.line } : null,
      orb_frames_before_card: card ? (cardAt < 0 ? shown.length : cardAt) : null,
      // the big orb's pace once it is up: the middle gap between its frames (16.7 is every frame at 60 a second)
      orb_frame_ms: card ? null : (() => { const g = shown.slice(1).map((f, i) => f.t - shown[i].t).sort((a, b) => a - b); return g.length ? Math.round(g[Math.floor(g.length / 2)] * 10) / 10 : null; })(),
      layout_shift: Math.round(h.shifts.reduce((n, s) => n + s.value, 0) * 10000) / 10000,
      console: said,
    };
  }, { latency, cpu, ...opts });
}

// ---- the head: what a phone reads to put the page on its home screen ----------------------

// Every meta tag by name, every icon link, and the title, from the live page,
// with the console after opening. An icon's href is cut to its first 40
// characters; decoded: an inline image that decodes in the page, with its size.
const HEAD = `(async function () {
  var meta = {};
  document.querySelectorAll('meta[name]').forEach(function (m) { meta[m.getAttribute('name')] = m.getAttribute('content'); });
  var links = [];
  var icons = document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]');
  for (var i = 0; i < icons.length; i++) {
    var l = icons[i];
    var img = new Image();
    var size = await new Promise(function (resolve) { img.onload = function () { resolve([img.naturalWidth, img.naturalHeight]); }; img.onerror = function () { resolve(null); }; img.src = l.href; });
    links.push({ rel: l.rel, type: l.type || null, sizes: l.getAttribute('sizes'), href: l.getAttribute('href').slice(0, 40), decoded: size });
  }
  return { title: document.title, lang: document.documentElement.lang, meta: meta, icons: links };
})()`;

async function headTrace(opts = {}) {
  const desk = trace.cardDesk(trace.CARDS.b1, async () => ({ card: trace.CARDS.b1 }));
  return openPage(desk, async (p, send, said) => {
    await p.until(AT_REST, 'the first card', 10000);
    await wait(300);
    return { ...(await p.run(HEAD)), console: said.slice() };
  }, opts);
}

// ---- a screen reader --------------------------------------------------------------------

// Four cards in a row, each reached by a tap: a question, an idea, a choice,
// the picked idea; then a tap the Mac refuses. heard: what the page's live
// region holds once each card is at rest, against the card's own words.
// refused: the one line why under the options, and how it is marked.
async function readerTrace(opts = {}) {
  const { q1, b1, c1, b2 } = trace.CARDS;
  const desk = trace.cardDesk(q1, async (action) => {
    if (action === 'answer') return { card: b1 };
    if (action === 'sharper') return { card: c1 };
    if (action === 'pick') return { card: b2 };
    return { ok: false, reason: 'gone', message: 'that did not go through. try again.' };
  });
  return openPage(desk, async (p, send, said) => {
    const heard = [];
    const hear = async (card) => {
      await p.until(titled(card.title), card.title, 10000);
      await wait(250);
      heard.push({ title: card.title, body: card.body || null, heard: await p.run("document.getElementById('said').textContent"), region: await p.run("(function () { var n = document.getElementById('said'); return [n.getAttribute('aria-live'), n.getAttribute('aria-atomic')]; })()") });
    };
    await hear(q1);
    await p.tapButton('making money from it');
    await hear(b1);
    await p.tapButton('sharper idea');
    await hear(c1);
    await p.tap("document.querySelector('#bet .option')", 'the first idea');
    await hear(b2);
    await p.tapButton('not now');
    await p.until("Boolean(document.querySelector('#bet .act .note')) && document.querySelector('#bet .act .note').textContent.length > 0", 'the line why', 10000);
    const refused = await p.run("(function () { var n = document.querySelector('#bet .act .note'); return { text: n.textContent, role: n.getAttribute('role'), live: n.getAttribute('aria-live') }; })()");
    return { heard, refused, console: said.slice() };
  }, opts);
}

// The page as a screen reader's list of landmarks has it, on an idea card:
// every landmark with its name, the card's own name, and every button that
// sits outside all of them (a screen reader's jump list never reaches it).
const LANDMARKS = new Set(['main', 'navigation', 'contentinfo', 'banner', 'complementary', 'region', 'form', 'search']);
async function landmarkTrace(opts = {}) {
  const card = trace.CARDS.b1;
  return openPage(trace.cardDesk(card, async () => ({ card })), async (p, send, said) => {
    await p.until(titled(card.title), 'the card', 10000);
    await wait(300);
    const { nodes } = await send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const role = n => (n.role && n.role.value) || '';
    const name = n => (n.name && n.name.value) || '';
    const inside = (n) => { for (let m = byId.get(n.parentId); m; m = byId.get(m.parentId)) if (LANDMARKS.has(role(m))) return role(m); return null; };
    const live = nodes.filter(n => !n.ignored);
    return {
      landmarks: live.filter(n => LANDMARKS.has(role(n))).map(n => [role(n), name(n)]),
      card: live.filter(n => role(n) === 'article').map(name),
      outside: live.filter(n => role(n) === 'button' && !inside(n)).map(name),
      console: said.slice(),
    };
  }, opts);
}

// ---- the focus ring -----------------------------------------------------------------------

// One stop per Tab press: what has the focus, and how wide its ring is on
// screen in css px: the outline's own width times the scale the element is
// drawn at (the small orb on a card is a big orb drawn at a fifth).
const FOCUSED = `(function () {
  var n = document.activeElement;
  if (!n || n === document.body) return null;
  var s = getComputedStyle(n);
  var scale = 1;
  for (var m = n; m && m.nodeType === 1; m = m.parentElement) {
    var t = getComputedStyle(m).transform;
    var k = t && t !== 'none' ? t.match(/matrix\\(([^,]+),\\s*([^,]+)/) : null;
    if (k) scale *= Math.hypot(Number(k[1]), Number(k[2]));
  }
  var width = s.outlineStyle === 'none' ? 0 : parseFloat(s.outlineWidth) || 0;
  var out = ((parseFloat(s.outlineOffset) || 0) + width) * scale;
  // the ring's outer box, and the room between it and what can be seen of
  // the nearest other control (below zero: the ring runs into it). A control
  // with a fill or an edge is seen whole; a bare link only where its words are.
  var seen = function (o) {
    var st = getComputedStyle(o);
    var filled = ['rgba(0, 0, 0, 0)', 'transparent'].indexOf(st.backgroundColor) < 0 || parseFloat(st.borderTopWidth) > 0 || o.tagName === 'CANVAS' || o.id === 'lava';
    if (filled) return o.getBoundingClientRect();
    var rg = document.createRange(); rg.selectNodeContents(o);
    var rs = Array.prototype.slice.call(rg.getClientRects());
    if (!rs.length) return o.getBoundingClientRect();
    return { left: Math.min.apply(null, rs.map(function (x) { return x.left; })), right: Math.max.apply(null, rs.map(function (x) { return x.right; })), top: Math.min.apply(null, rs.map(function (x) { return x.top; })), bottom: Math.max.apply(null, rs.map(function (x) { return x.bottom; })), width: 1, height: 1 };
  };
  var b = n.getBoundingClientRect();
  var ring = { left: b.left - out, right: b.right + out, top: b.top - out, bottom: b.bottom + out };
  var room = Infinity, nearest = null;
  Array.prototype.forEach.call(document.querySelectorAll('button, [tabindex], input'), function (o) {
    if (o === n || o.contains(n) || n.contains(o)) return;
    var box = o.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(o).visibility === 'hidden') return;
    var r = seen(o);
    var gap = Math.max(r.left - ring.right, ring.left - r.right, r.top - ring.bottom, ring.top - r.bottom);
    if (gap < room) { room = gap; nearest = o.id || (o.textContent || '').trim().slice(0, 40); }
  });
  return { what: n.id || (n.textContent || '').trim().slice(0, 40) || n.tagName.toLowerCase(), ring_px: Math.round(width * scale * 100) / 100, offset_px: Math.round((parseFloat(s.outlineOffset) || 0) * scale * 100) / 100, room_px: Number.isFinite(room) ? Math.round(room * 10) / 10 : null, nearest: nearest };
})()`;

async function tabStops(p, send, most = 12) {
  const stops = [];
  for (let i = 0; i < most; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await wait(60);
    const at = await p.run(FOCUSED);
    if (at && stops.some(x => x.what === at.what)) break;
    if (at) stops.push(at);
  }
  return stops;
}

// Tab through an idea card, then through the big orb with no card.
async function focusTrace(opts = {}) {
  const card = trace.CARDS.b1;
  const out = {};
  await openPage(trace.cardDesk(card, async () => ({ card })), async (p, send, said) => {
    await p.until(titled(card.title), 'the card', 10000);
    out.card = await tabStops(p, send);
    out.console = said.slice();
  }, opts);
  await openPage(trace.cardDesk(null, async () => ({ card })), async (p, send) => {
    await p.until("document.getElementById('orb').__orb.frame > 2", 'the big orb', 10000);
    out.orb = await tabStops(p, send);
  }, opts);
  return out;
}

// ---- zoom -----------------------------------------------------------------------------

// 200% zoom is the same page laid out at half the width: a 390 phone is 195
// css px wide, a 320 phone 160, a 1280 laptop 640 by 400.
const ZOOMED = {
  phone: { width: 195, height: 422, deviceScaleFactor: 6, mobile: true },
  small: { width: 160, height: 284, deviceScaleFactor: 4, mobile: true },
  laptop: { width: 640, height: 400, deviceScaleFactor: 2, mobile: false },
};

// how much wider than the screen the page is, and what on it reaches past
// either edge (a table's own sideways scroll is its own)
const EDGES = `(function () {
  var vw = document.documentElement.clientWidth;
  var past = [];
  document.querySelectorAll('#bet *, .foot *, #line, #stage').forEach(function (n) {
    if (n.closest('.grid') && !n.classList.contains('grid')) return;
    var r = n.getBoundingClientRect();
    if (!r.width || getComputedStyle(n).visibility === 'hidden') return;
    if (r.right > vw + 0.5 || r.left < -0.5) past.push(String(n.className || n.tagName).split(' ')[0] + ' ' + Math.round(r.left) + ' to ' + Math.round(r.right));
  });
  return { wider_px: document.documentElement.scrollWidth - vw, past_edges: past.slice(0, 8) };
})()`;

// The big orb and five kinds of card at each zoomed size.
async function zoomTrace({ sizes = Object.keys(ZOOMED), ...opts } = {}) {
  const { b1, q1, c1, yes, calm } = trace.CARDS;
  const out = [];
  for (const size of sizes) {
    const viewport = ZOOMED[size];
    for (const [name, card] of [['big orb', null], ['idea', b1], ['question', q1], ['choice', c1], ['yes', yes], ['calm line', calm]]) {
      const ready = !card ? "document.getElementById('orb').__orb.frame > 2" : card.kind === 'wait' ? "document.body.classList.contains('waiting')" : titled(card.title);
      out.push(await openPage(trace.cardDesk(card, async () => ({ card })), async (p, send, said) => {
        await p.until(ready, `${name} at ${size}`, 10000);
        await wait(400);
        return { size, card: name, ...(await p.run(EDGES)), console: said.length };
      }, { viewport, ...opts }));
    }
  }
  return out;
}

// The big orb drawn: its canvas's css size, its backing store against css
// size times the pixel ratio the page draws at (capped at 2), and where the
// lit dots actually sit: their box's middle against the canvas's middle,
// and their radius against the canvas's width, in css px.
const SPHERE = `(function () {
  var c = document.getElementById('orb');
  var ratio = Math.min(window.devicePixelRatio || 1, 2);
  // read from a copy, so the page's own canvas is never read back
  var copy = document.createElement('canvas');
  copy.width = c.width; copy.height = c.height;
  var cx = copy.getContext('2d', { willReadFrequently: true });
  cx.drawImage(c, 0, 0);
  var data = cx.getImageData(0, 0, c.width, c.height).data;
  var minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (var y = 0; y < c.height; y += 2) for (var x = 0; x < c.width; x += 2) {
    if (data[(y * c.width + x) * 4 + 3] > 6) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  var k = c.clientWidth / (c.width || 1);
  return {
    css: [c.clientWidth, c.clientHeight],
    store: [c.width, c.height],
    want: [Math.round(c.clientWidth * ratio), Math.round(c.clientHeight * ratio)],
    off_center_px: maxX < 0 ? null : Math.round(Math.max(Math.abs((minX + maxX) / 2 * k - c.clientWidth / 2), Math.abs((minY + maxY) / 2 * k - c.clientHeight / 2)) * 10) / 10,
    radius_of_width: maxX < 0 ? null : Math.round((maxX - minX) / 2 / (c.width || 1) * 1000) / 1000,
  };
})()`;

// The big orb on a laptop, then the page zoomed to 200% (half the width,
// twice the pixels), then back.
async function sphereZoomTrace(opts = {}) {
  const out = {};
  await openPage(trace.cardDesk(null, async () => ({ card: trace.CARDS.b1 })), async (p, send, said) => {
    await p.until("document.getElementById('orb').__orb.frame > 0", 'the big orb', 10000);
    await wait(1500);
    out.before = await p.run(SPHERE);
    await send('Emulation.setDeviceMetricsOverride', ZOOMED.laptop);
    await wait(1500);
    out.zoomed = await p.run(SPHERE);
    await send('Emulation.setDeviceMetricsOverride', trace.LAPTOP);
    await wait(1500);
    out.back = await p.run(SPHERE);
    out.console = said.slice();
  }, { viewport: trace.LAPTOP, ...opts });
  return out;
}

// ---- a long session ------------------------------------------------------------------

const TEAM_ROWS = [
  { member: 'builder', role: 'writes and tests the code', ovr: '81', engine: 'm-one', sentence: 'working: the getting started page.', status: 'working' },
  { member: 'navigator', role: 'finds where things are', ovr: '77', engine: 'm-two', sentence: 'waiting for your yes: the weekly note.', status: 'waiting for your yes' },
  { member: 'validator', role: 'checks the work', ovr: '74', engine: 'm-one', sentence: 'idle.', status: 'idle' },
];
const deckJob = i => ({
  job_id: `job-${i}`, member: TEAM_ROWS[i].member, label: TEAM_ROWS[i].status, time: 'about an hour left', yes: null, said: null,
  rows: [{ member: TEAM_ROWS[i].member, role: TEAM_ROWS[i].role, work: `job ${i + 1}: the getting started page`, status: TEAM_ROWS[i].status, done: 'not yet' }],
});

// One round of the owner's moves, each ending on a new card at rest: an
// answer through the sphere (sharper, a choice, a picked idea), words said
// and the reply to them, the team table, the job deck turned in place, back
// to the team, then home to the big orb, the calm line, and the idea that
// grows out of its dots. A round lands 11 cards.
const ROUND = 11;

// What the page holds after each round, every count read after two forced
// collections: chrome's own counts of listeners, nodes, and documents, the
// js heap, and the probe's timers, intervals, frames, and canvases.
async function sessionTrace({ cards = 100, ...opts } = {}) {
  let n = 0, at = 0, deck = false;
  const id = k => `${k}-${++n}`;
  const idea = () => gmCard.idea({ id: id('bet'), title: `idea ${n} for the phone page`, body: `installs last week were ${1400 + n}. more people try it by nov 1.` });
  const team = () => gmCard.team({ id: id('team'), rows: TEAM_ROWS, deck: true });
  const deckCard = () => gmCard.deck({ id: id('deck'), at, total: TEAM_ROWS.length, card: deckJob(at), columns: ['member', 'role', 'work', 'status', 'done'], job: { member: TEAM_ROWS[at].member, role: TEAM_ROWS[at].role } });
  let desk = null;
  desk = trace.cardDesk(idea(), async (action, { card, option }) => {
    if (action === 'sharper') return { card: gmCard.question({ id: id('question'), title: `what matters most this month, ${n}?`, body: 'installs dropped last week.', choices: [{ id: 'money', label: 'making money from it' }, { id: 'users', label: 'more people using it' }] }) };
    if (action === 'answer') return { card: gmCard.choice({ id: id('choice'), items: [{ id: `o${n}`, title: `Record demo video ${n}`, why: 'people trust what they can watch.' }, { id: `p${n}`, title: `Send note ${n} to the schools`, why: 'they asked for it.' }] }) };
    if (action === 'say') return { card: gmCard.reply({ id: id('reply'), base: card, text: 'a short page that walks a new person to their first card.', suggestions: ['sounds good'] }) };
    if (action === 'open:team' || (action === 'back' && deck)) { deck = false; return { card: team() }; }
    if (action === 'deck') { deck = true; at = 0; return { card: deckCard() }; }
    if (action === 'flip') { at = (at + option.binds.step + TEAM_ROWS.length) % TEAM_ROWS.length; return { card: deckCard() }; }
    if (action === 'orb') {
      // the next idea is written while the calm line shows, then it is up on the Mac
      setTimeout(() => { desk.current = idea(); }, 1200);
      return { card: gmCard.wait({ id: id('wait'), progress: [{ at: Date.now(), line: 'drafting three ideas at once' }], started_at: Date.now() }) };
    }
    return { card: idea() };
  });
  return openPage(desk, async (p, send, said) => {
    const kind = k => `${AT_REST} && document.getElementById('bet').getAttribute('data-kind') === ${JSON.stringify(k)}`;
    const ready = k => p.until(k === 'wait' ? "document.body.classList.contains('waiting') && Boolean(document.querySelector('#bet .sayline .field')) && !document.body.hasAttribute('data-busy')" : kind(k), `a ${k} card`, 15000);
    const sample = async (landed) => {
      await wait(1200);
      await send('HeapProfiler.collectGarbage');
      await wait(100);
      await send('HeapProfiler.collectGarbage');
      const dom = await send('Memory.getDOMCounters');
      const heap = await send('Runtime.getHeapUsage');
      return { cards: landed, heap_kb: Math.round(heap.usedSize / 1024), listeners: dom.jsEventListeners, dom_nodes: dom.nodes, documents: dom.documents, ...(await p.run('window.__health.counts()')) };
    };
    const started = Date.now();
    await ready('idea');
    let landed = 0;
    const rows = [];
    const land = async (k, move) => { await move(); await ready(k); landed += 1; };
    // first, a card the Mac changes with no tap: it turns in place on the next look
    const fresh = idea();
    desk.current = fresh;
    await p.until(titled(fresh.title), 'the card the Mac changed', 15000);
    landed += 1;
    while (landed < cards) {
      await land('question', () => p.tapButton('sharper idea'));
      await land('choice', () => p.tapButton('making money from it'));
      await land('idea', () => p.tap("document.querySelector('#bet .option')", 'the first idea'));
      await land('reply', async () => {
        await p.tapButton('or say something');
        await p.until("Boolean(document.querySelector('#bet .field input')) && document.activeElement === document.querySelector('#bet .field input')", 'the box', 5000);
        await send('Input.insertText', { text: 'what do you mean' });
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      });
      await land('idea', () => p.tapButton('not now'));
      await land('team', () => p.tapButton('the team'));
      await land('deck', () => p.tapButton('the jobs, one at a time'));
      await land('deck', () => p.tapButton('next'));
      await land('team', () => p.tapButton('the whole team'));
      await land('wait', async () => {
        await p.tap("document.getElementById('lava')", 'the small orb');
        await p.until("!document.body.classList.contains('has-card') && !document.body.hasAttribute('data-busy')", 'the big orb', 10000);
        await p.tap("document.getElementById('orb')", 'the big orb');
      });
      await land('idea', async () => {});
      rows.push(await sample(landed));
    }
    const first = rows[0], last = rows[rows.length - 1];
    const grew = {};
    for (const k of ['heap_kb', 'listeners', 'dom_nodes', 'documents', 'intervals', 'timeouts', 'frames', 'canvases_made', 'canvases', 'nodes', 'copies']) grew[k] = last[k] - first[k];
    // layout shift over the whole session as the browser scores it (a shift
    // right after a tap or a key is the answer to it, so it is not counted),
    // and every shift that moved anything, counted or not
    const shifts = await p.run('window.__health.shifts');
    const moved = shifts.filter(x => x.value > 0);
    const score = list => Math.round(list.reduce((t, x) => t + x.value, 0) * 10000) / 10000;
    return {
      cards: landed, seconds: Math.round((Date.now() - started) / 1000), samples: rows, grew_after_first_round: grew,
      layout_shift: score(moved.filter(x => !x.input)),
      layout_shift_after_taps: score(moved.filter(x => x.input)),
      shifts: moved.slice(0, 12).map(x => ({ value: Math.round(x.value * 10000) / 10000, at_ms: Math.round(x.t), after_input: x.input, what: x.what })),
      console: said.filter(l => !(l.kind === 'error' && /status of 409/.test(l.text))),
    };
  }, opts);
}

// ---- the Mac asleep ---------------------------------------------------------------------

// The Mac goes to sleep under a card: it takes every connection and answers
// none. After asleepMs the owner taps "sharper idea"; then the Mac wakes and
// answers what it held. Then the same on the calm line, which looks more
// often. card_asks_out: asks for the card still waiting when the owner
// tapped; tap_reached_mac: the tap's post got to the Mac while it slept, not
// stuck behind the asks; next_card: the card the page came to after waking.
async function asleepTrace({ asleepMs = 32000, calmMs = 12000, ...opts } = {}) {
  const { b1, b2, calm } = trace.CARDS;
  const desk = trace.cardDesk(b1, async () => ({ card: b2 }));
  const out = {};
  await openPage(desk, async (p, send, said, server) => {
    await p.until(titled(b1.title), 'the first card', 10000);
    server.sleep();
    await wait(asleepMs);
    out.card_asks_out = await p.run("window.__health.asks.out['GET /card'] || 0");
    const before = server.held.length;
    await p.tapButton('sharper idea');
    await wait(2500);
    out.tap_reached_mac = server.held.slice(before).some(([q]) => q.method === 'POST');
    out.asks_held_by_mac = server.held.length;
    server.wake();
    await p.until(titled(b2.title), 'the next card after waking', 10000).then(() => { out.next_card = b2.title; }, () => { out.next_card = null; });
    out.console = said.slice();
  }, opts);
  // the calm line looks for the idea every second and a half
  const calmDesk = trace.cardDesk(calm, async () => ({ card: calm }));
  await openPage(calmDesk, async (p, send, said, server) => {
    await p.until("document.body.classList.contains('waiting') && Boolean(document.querySelector('#bet .sayline .field'))", 'the calm line', 10000);
    server.sleep();
    await wait(calmMs);
    out.calm_card_asks_out = await p.run("window.__health.asks.out['GET /card'] || 0");
    out.calm_card_asks_most = await p.run("window.__health.asks.most['GET /card'] || 0");
    server.wake();
  }, opts);
  return out;
}

module.exports = { PROBE, consoleLine, serveDesk, openPage, AT_REST, titled, firstPaintTrace, headTrace, readerTrace, landmarkTrace, focusTrace, ZOOMED, zoomTrace, sphereZoomTrace, ROUND, sessionTrace, asleepTrace };

if (require.main === module) {
  const fail = (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); };
  const print = out => process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (process.argv.includes('--paint')) {
    (async () => {
      const out = [];
      for (const card of [trace.CARDS.b1, null]) for (const cpu of [1, 4]) out.push({ card: Boolean(card), ...(await firstPaintTrace({ card, cpu })) });
      print(out);
    })().catch(fail);
  } else if (process.argv.includes('--head')) {
    headTrace().then(print, fail);
  } else if (process.argv.includes('--reader')) {
    (async () => print({ cards: await readerTrace(), landmarks: await landmarkTrace() }))().catch(fail);
  } else if (process.argv.includes('--focus')) {
    focusTrace().then(print, fail);
  } else if (process.argv.includes('--zoom')) {
    (async () => print({ pages: await zoomTrace(), sphere: await sphereZoomTrace() }))().catch(fail);
  } else if (process.argv.includes('--long')) {
    const at = process.argv.indexOf('--long');
    sessionTrace({ cards: Number(process.argv[at + 1]) || 100 }).then(print, fail);
  } else if (process.argv.includes('--asleep')) {
    asleepTrace().then(print, fail);
  } else {
    process.stdout.write('node scripts/gm-phone-health.js --paint | --head | --reader | --focus | --zoom | --long [cards] | --asleep\n');
  }
}

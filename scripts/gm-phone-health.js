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
//   require('./scripts/gm-phone-health')        the traces, for tests

const trace = require('./gm-phone-trace');

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the probe: in the page before its own script -------------------------------------

// What the page did from its first moment: each paint, each layout shift,
// and one row per animation frame for the first FRAMES frames saying what
// was on screen then (a card, or the big orb with its line).
const FRAMES = 90;
const PROBE = `(function () {
  var P = window.__health = { paints: [], shifts: [], frames: [] };
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { P.paints.push({ name: e.name, t: e.startTime }); }); }).observe({ type: 'paint', buffered: true }); } catch (e) { /* no paint timing */ }
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        P.shifts.push({ value: e.value, t: e.startTime, input: e.hadRecentInput, what: (e.sources || []).map(function (s) { return s.node ? (s.node.id || String(s.node.className || s.node.nodeName)) : 'gone'; }) });
      });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* no layout shift timing */ }
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

// The real page with this desk, reopened from nothing with the probe in it.
// latency: ms each request waits on the way (a phone on wifi); cpu: how many
// times slower the cpu runs (1 is this machine). fn(p, send, said) drives it;
// said is every console line so far.
async function openPage(desk, fn, { chromePath = trace.findChrome(), viewport = trace.PHONE, reduced = false, latency = 0, cpu = 1, page } = {}) {
  return trace.onPhone(desk, chromePath, async (p, send) => {
    const said = [];
    send.on((m) => { const line = consoleLine(m); if (line) said.push(line); });
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    if (latency) await send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
    if (cpu > 1) await send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await send('Page.reload', { ignoreCache: true });
    await wait(200);
    await p.until("document.readyState === 'complete' && Boolean(window.__health)", 'the page to open again', 15000);
    return fn(p, send, said);
  }, viewport, { firstCard: false, reduced, ...(page ? { page } : {}) });
}

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
    await wait(600);
    const h = await p.run('window.__health');
    const fcp = h.paints.find(x => x.name === 'first-contentful-paint');
    const shown = h.frames;
    const first = shown[0] || null;
    const cardAt = shown.findIndex(f => f.card);
    return {
      latency_ms: latency,
      cpu,
      first_paint_ms: fcp ? Math.round(fcp.t) : null,
      first_frame: first ? { card: first.card, title: first.title, dots: first.dots, line: first.line } : null,
      orb_frames_before_card: card ? (cardAt < 0 ? shown.length : cardAt) : null,
      layout_shift: Math.round(h.shifts.reduce((n, s) => n + s.value, 0) * 10000) / 10000,
      console: said,
    };
  }, { latency, cpu, ...opts });
}

module.exports = { PROBE, consoleLine, openPage, firstPaintTrace };

if (require.main === module) {
  const fail = (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); };
  const print = out => process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (process.argv.includes('--paint')) {
    (async () => {
      const out = [];
      for (const card of [trace.CARDS.b1, null]) for (const cpu of [1, 4]) out.push({ card: Boolean(card), ...(await firstPaintTrace({ card, cpu })) });
      print(out);
    })().catch(fail);
  } else {
    process.stdout.write('node scripts/gm-phone-health.js --paint\n');
  }
}

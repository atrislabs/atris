#!/usr/bin/env node
'use strict';

// How every card sits on the screen. Serves the real phone page with a desk
// that holds one card, opens it at rest in headless Chrome at each size
// (phones small and large, a phone on its side, a laptop), and reads the
// boxes the page actually drew: the card column and its margins, the title's
// size and lines, every tap target, the gaps between options, where the
// footer and the small orb sit, anything that spills past the screen edge,
// and the contrast of every line of words against what is behind it.
// Chrome starts through scripts/gm-phone-trace.js, which uses
// lib/headless-chrome.js.
//
//   node scripts/gm-phone-layout.js               prints every card at every size as json
//   node scripts/gm-phone-layout.js --shots DIR   also saves a screenshot of each
//   node scripts/gm-phone-layout.js --kind idea   only cards of that kind
//   require('./scripts/gm-phone-layout')          { layout, CASES, VIEWPORTS, MEASURE }

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const phone = require('../lib/gm-phone');
const gmCard = require('../lib/gm-card');
const { phonePage } = require('../lib/gm-phone-page');
const trace = require('./gm-phone-trace');

const TOKEN = 't'.repeat(43);
const wait = ms => new Promise(r => setTimeout(r, ms));

// the sizes the orb has to look right at; notch: the safe area a phone with
// a notch and a home bar reports, in css pixels
const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, notch: { top: 47, bottom: 34 } },
  big: { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, notch: { top: 59, bottom: 34 } },
  small: { width: 320, height: 568, deviceScaleFactor: 2, mobile: true, notch: null },
  side: { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, notch: { left: 47, right: 47, bottom: 21 } },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, notch: null },
};

const LONG = 'Write a getting started page that walks a brand new person from the install all the way to their very first card on the phone';
const TEAM_ROWS = [
  { member: 'navigator', role: 'system navigator', ovr: '84', engine: 'tool one m-small', status: 'waiting for your yes', sentence: 'waiting for your yes: plan the pricing page, waiting 2 hours' },
  { member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: launch a try page for any public repo, about 4 hours left' },
  { member: 'auto-improver', role: 'continuous improver', ovr: 'new', engine: 'tool one m-one', status: 'stopped', sentence: 'stopped: split the big test file so each part runs alone, stopped 30 minutes ago' },
];
const DECK_JOB = { job_id: 'm-nav', mission_id: 'm-nav', member: 'navigator', label: 'needs you', time: 'waiting 2 hours', rows: [{ done: 'not yet', work: 'plan the pricing page', member: 'navigator', role: 'system navigator', status: 'needs you' }], yes: { key: 'm-nav:step-2:abc', hash: 'abc', what: 'navigator wants to publish the pricing page', why: 'navigator is waiting on your yes for this.' } };
const SWAP = {
  line: 'builder runs on tool one m-one.',
  scopes: [{ id: 'member', label: 'just builder' }, { id: 'job', label: 'for every build job' }],
  options: [
    { engine: 'atris', tool: 'atris', model: 'fast', label: 'atris fast', current: false, record: null },
    { engine: 'one', tool: 'tool one', model: 'm-one', label: 'm-one', current: true, record: '3 of 4 landed' },
    { engine: 'two', tool: 'tool two', model: 'm-two', label: 'm-two', current: false, record: '2 of 2 landed' },
  ],
};

// one card of every kind, and the long words that have to wrap well
const CASES = [
  // no card: the big orb and the line under it
  { name: 'home', card: null },
  { name: 'idea', card: gmCard.idea({ id: 'bet-1', title: 'Write a getting started page for the phone', body: 'installs last week were 1,400. more people try it by nov 1.' }) },
  { name: 'idea-long', card: gmCard.idea({ id: 'bet-2', title: LONG, body: 'installs last week were 1,400, down from 1,640 the week before, and most people who leave do it before their first card. more people try it by nov 1.', concern: 'the second look worried the page might be too long for a phone.' }) },
  { name: 'question', card: trace.CARDS.q1 },
  { name: 'question-long', card: gmCard.question({ id: 'question:long', title: 'what matters most for this project this month, now that installs are down?', body: 'installs dropped to 1,511 last week.', choices: [{ id: 'money', label: 'making money from the people who already use it every single week' }, { id: 'users', label: 'more people using it' }, { id: 'other', label: 'something else', other: true }] }) },
  { name: 'choice', card: gmCard.choice({ id: 'choice:o1,o2', items: [{ id: 'o1', title: 'Record a two minute demo video for the readme', why: 'people trust what they can watch, and the readme has no video yet.' }, { id: 'o2', title: 'Send the weekly note to the twelve schools', why: 'they asked for it last week.' }] }) },
  { name: 'yes', card: gmCard.yes({ id: 'yes:m1:step-3:abc', title: 'builder wants to send the weekly note to the twelve schools', body: 'it goes out from your account, so it waits for your yes.', request: { job: 'm1', key: 'm1:step-3:abc', hash: 'abc' }, job: { member: 'builder', role: 'builder' } }) },
  { name: 'yes-long-words', card: gmCard.yes({ id: 'yes:m1:step-4:def', title: 'builder wants to email principals@twelveschoolsnetwork.org', body: 'it goes out from hello@atrisorbgettingstarted.com, so it waits for your yes.', request: { job: 'm1', key: 'm1:step-4:def', hash: 'def' } }) },
  { name: 'done', card: gmCard.done({ id: 'done:m1', title: 'the getting started page is live', body: 'builder finished it this morning.', job: { member: 'builder', role: 'builder' } }) },
  { name: 'missed', card: gmCard.missed({ id: 'missed:1' }) },
  { name: 'report', card: gmCard.report({ id: 'report:installs', title: 'how many installs this week?', body: 'last week was 1,511.' }) },
  { name: 'started', card: gmCard.started({ id: 'started:1', title: 'Write a getting started page for the phone', body: 'installs last week were 1,400.', line: 'builder has it.' }) },
  { name: 'reply', card: gmCard.reply({ id: 'bet-1~r1', base: trace.CARDS.b1, text: 'a short page that walks a new person from install to their first card, with one example. want it shorter?', suggestions: ['sounds good', 'make it shorter'] }) },
  { name: 'reply-thread', card: gmCard.reply({ id: 'member~1~r2', base: gmCard.member({ id: 'member~1', name: 'builder', sentence: 'working on the getting started page.' }), text: 'i will start with the install step and send you the first draft tonight. want the example to be a school?', thread: [{ who: 'owner', text: 'take the readme first' }, { who: 'orb', text: 'on it. the readme first, then the page.' }], suggestions: ['yes, a school', 'no example'] }) },
  { name: 'team', card: gmCard.team({ id: 'team~1', rows: TEAM_ROWS }) },
  { name: 'member', card: gmCard.member({ id: 'member~1', name: 'builder', sentence: 'stopped: the getting started page, stopped 2 hours ago.' }) },
  { name: 'deck', card: gmCard.deck({ id: 'deck~1', at: 0, total: 3, card: DECK_JOB, columns: ['done', 'work', 'member', 'role', 'status'], job: { member: 'navigator', role: 'system navigator' } }) },
  { name: 'swap', card: gmCard.swap({ id: 'swap~1', name: 'builder', choices: SWAP }) },
  { name: 'wait', card: gmCard.wait({ id: 'wait:1', progress: [{ at: Date.now() - 14000, line: 'drafting three ideas at once' }], waited_ms: 14000 }) },
  { name: 'wait-notes', card: gmCard.wait({ id: 'wait:2', progress: [{ at: Date.now() - 14000, line: 'drafting three ideas at once' }], waited_ms: 14000, thread: [{ who: 'owner', text: 'make it about schools' }, { who: 'orb', text: 'got it, i\'ll fold that in.' }] }) },
];

// What the page drew, in css pixels, read in the page.
const MEASURE = `(function () {
  var vw = document.documentElement.clientWidth, vh = window.innerHeight;
  function R(n) { var b = n.getBoundingClientRect(); return { left: +b.left.toFixed(1), top: +(b.top + window.scrollY).toFixed(1), right: +b.right.toFixed(1), bottom: +(b.bottom + window.scrollY).toFixed(1), width: +b.width.toFixed(1), height: +b.height.toFixed(1) }; }
  function vis(n) { var s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; var b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }
  function rgb(c) { var m = String(c).match(/[\\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; }
  function lum(c) { var v = c.slice(0, 3).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
  function over(top, under) { var a = top.length > 3 ? top[3] : 1; return [0, 1, 2].map(function (i) { return top[i] * a + under[i] * (1 - a); }); }
  function behind(n) {
    var layers = [];
    for (var x = n; x && x.nodeType === 1; x = x.parentElement) { var c = rgb(getComputedStyle(x).backgroundColor); if (c.length < 4 || c[3] > 0) layers.push(c); if (c.length < 4 || c[3] === 1) break; }
    var base = rgb(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    for (var i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  }
  function ratio(a, b) { var x = lum(a), y = lum(b); return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2); }
  function lines(n) { var r = document.createRange(); r.selectNodeContents(n); var tops = {}; Array.prototype.forEach.call(r.getClientRects(), function (x) { if (x.width > 0) tops[Math.round(x.top)] = 1; }); return Object.keys(tops).length; }
  var box = document.getElementById('bet');
  var h1 = box.querySelector('h1');
  var hs = h1 && getComputedStyle(h1);
  var taps = Array.prototype.filter.call(document.querySelectorAll('#bet button, #bet .field, #bet tr.row, .foot button, #lava.tap'), vis).map(function (n) {
    var s = getComputedStyle(n);
    return { what: (n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ').join('.') : '')), text: String(n.textContent || '').trim().slice(0, 48), radius: s.borderTopLeftRadius, border: s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none' ? s.borderTopColor : null, font: parseFloat(s.fontSize), spills: n.scrollWidth > n.clientWidth + 1, in_table: Boolean(n.closest('.grid')), rect: R(n) };
  });
  var words = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var t = walker.nextNode(); t; t = walker.nextNode()) {
    var p = t.parentElement;
    if (!String(t.textContent).trim() || !p || !vis(p) || p.closest('[aria-hidden="true"]') || p.closest('.muted')) continue;
    var ps = getComputedStyle(p);
    words.push({ text: String(t.textContent).trim().slice(0, 40), color: ps.color, ratio: ratio(rgb(ps.color), behind(p)), font: parseFloat(ps.fontSize) });
  }
  var spill = Array.prototype.filter.call(document.querySelectorAll('body *'), function (n) {
    if (!vis(n) || n.closest('.grid') || n.closest('#lava') || n.id === 'lava') return false;
    var b = n.getBoundingClientRect();
    return b.right > vw + 0.5 || b.left < -0.5;
  }).map(function (n) { return n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ').join('.') : ''); });
  var acts = Array.prototype.filter.call(box.querySelectorAll('.act > button, .act > .field, .options > button'), vis).map(R);
  var gaps = [];
  for (var i = 1; i < acts.length; i++) gaps.push(+(acts[i].top - acts[i - 1].bottom).toFixed(1));
  var lava = document.getElementById('lava');
  var radii = {};
  Array.prototype.forEach.call(document.querySelectorAll('#bet *, .foot *'), function (n) { if (!vis(n)) return; var s = getComputedStyle(n); if (s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none' && s.borderTopLeftRadius !== '0px') radii[s.borderTopLeftRadius] = (radii[s.borderTopLeftRadius] || 0) + 1; });
  var foot = document.getElementById('foot');
  return {
    vw: vw, vh: vh,
    scroll_w: document.documentElement.scrollWidth,
    scroll_h: document.documentElement.scrollHeight,
    kind: box.getAttribute('data-kind'),
    card: vis(box) ? R(box) : null,
    title: h1 ? { rect: R(h1), font: parseFloat(hs.fontSize), line_height: parseFloat(hs.lineHeight), lines: lines(h1), align: hs.textAlign, family: hs.fontFamily.split(',')[0] } : null,
    body: box.querySelector('.why') ? { rect: R(box.querySelector('.why')), font: parseFloat(getComputedStyle(box.querySelector('.why')).fontSize), lines: lines(box.querySelector('.why')) } : null,
    taps: taps,
    gaps: gaps,
    radii: radii,
    words_low: words.filter(function (w) { return w.ratio < 4.5; }),
    smallest_ratio: words.length ? Math.min.apply(null, words.map(function (w) { return w.ratio; })) : null,
    spill: spill,
    foot: vis(foot) ? R(foot) : null,
    lava: lava.style.visibility === 'visible' ? R(lava) : null,
    stage: vis(document.getElementById('stage')) ? R(document.getElementById('stage')) : null,
    line: vis(document.getElementById('line')) ? R(document.getElementById('line')) : null,
    safe: { top: getComputedStyle(document.getElementById('screen')).paddingTop, bottom: getComputedStyle(document.getElementById('screen')).paddingBottom, left: getComputedStyle(document.getElementById('screen')).paddingLeft, right: getComputedStyle(document.getElementById('screen')).paddingRight },
    fonts: document.fonts ? document.fonts.status : null,
  };
})()`;

// a desk that holds one card, whatever is tapped
function holdDesk() {
  let current = null;
  return {
    set: (c) => { current = c; },
    card: () => ({ ok: true, card: gmCard.wire(current), status: current ? 'ready' : 'idle', queue: 0, team_working: 0, needs_you: 0 }),
    act: async () => ({ status: 200, body: { ok: true, card: gmCard.wire(current), status: 'ready', queue: 0, team_working: 0, needs_you: 0 } }),
  };
}

async function serve(desk, page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-layout-'));
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: dir, token: TOKEN, hosts, loadView: () => ({}), runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true, snapshotTarget: () => () => true, logPath: path.join(dir, 'gm-phone-actions.jsonl'), page, makeBetDesk: () => desk,
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  return { url: `http://${base}/?t=${TOKEN}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }) };
}

const AT_REST = "document.readyState === 'complete' && !document.body.hasAttribute('data-busy') && ((document.body.classList.contains('has-card') && !document.getElementById('bet').hidden && document.getElementById('bet').classList.contains('up')) || (!document.body.classList.contains('has-card') && document.getElementById('line').textContent === 'tap to think'))";

// Every case at every viewport, in one Chrome. notch: also emulate the
// viewport's safe area. probe: one more expression read in the page at
// rest, kept as the row's probe. Returns one row per case and viewport.
async function layout({ chromePath = trace.findChrome(), cases = CASES, viewports = Object.keys(VIEWPORTS), notch = true, reduced = false, shots = null, page = phonePage, probe = null } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const desk = holdDesk();
  const server = await serve(desk, page);
  let chrome = null;
  const out = [];
  try {
    try { chrome = await trace.launch(chromePath); } catch { chrome = await trace.launch(chromePath); }
    const { send } = chrome;
    await send('Page.enable');
    if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const at of viewports) {
      // a name from VIEWPORTS, or a size of its own ({ name, width, height, ... })
      const v = typeof at === 'string' ? VIEWPORTS[at] : at;
      const name = typeof at === 'string' ? at : at.name;
      await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.mobile });
      const inset = notch && v.notch ? { top: 0, bottom: 0, left: 0, right: 0, ...v.notch } : { top: 0, bottom: 0, left: 0, right: 0 };
      let safeArea = false;
      try { await send('Emulation.setSafeAreaInsetsOverride', { insets: inset }); safeArea = true; } catch { /* an older chrome */ }
      for (const c of cases) {
        desk.set(c.card);
        await send('Page.navigate', { url: server.url });
        const p = { run: async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; } };
        const end = Date.now() + 8000;
        while (Date.now() < end && !(await p.run(AT_REST).catch(() => false))) await wait(30);
        await wait(700);
        const m = await p.run(MEASURE);
        out.push({ case: c.name, viewport: name, size: `${v.width}x${v.height}`, safe_area: safeArea ? inset : null, ...m, probe: probe ? await p.run(probe) : null });
        if (shots) {
          fs.mkdirSync(shots, { recursive: true });
          // the whole page when it runs past the screen, else just the screen, so a
          // capture never resizes the page under a layout that fits
          const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: m.scroll_h > m.vh + 1 });
          fs.writeFileSync(path.join(shots, `${c.name}-${name}${reduced ? '-reduced' : ''}.png`), Buffer.from(data, 'base64'));
        }
      }
    }
  } finally {
    // ask Chrome to quit first, so its helper processes go with it and nothing holds the run open
    if (chrome) { await Promise.race([chrome.send('Browser.close').catch(() => {}), wait(2000)]); chrome.close(); }
    await server.close();
  }
  return out;
}

module.exports = { layout, CASES, VIEWPORTS, MEASURE, LONG };

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const shots = arg('--shots') ? path.resolve(arg('--shots')) : null;
  const kind = arg('--kind');
  const only = arg('--viewport');
  const cases = kind ? CASES.filter(c => c.name === kind || c.name.startsWith(`${kind}-`)) : CASES;
  layout({ cases, shots, viewports: only ? only.split(',') : undefined, reduced: process.argv.includes('--reduced') }).then((out) => {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }, (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}

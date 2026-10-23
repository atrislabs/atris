#!/usr/bin/env node
'use strict';

// A frame trace of the gm phone page in headless Chrome at phone size.
// It serves the real page through the real phone handler with a scripted
// desk, drives it with real pointer and key events, and records every frame
// where the card's title, the typing spot, and each answer sit. The summary
// says how far each one moved, so "the eyes stay in one place" is a number.
// Node built-ins and a local Chrome only.
//
//   node scripts/gm-phone-trace.js              prints the summary as json
//   node scripts/gm-phone-trace.js --shots DIR  also saves a phone screenshot
//                                               at each moment (slows frames;
//                                               read the numbers from a plain run)
//   node scripts/gm-phone-trace.js --team       the team table at phone and
//                                               laptop size (--shots DIR saves both)
//   require('./scripts/gm-phone-trace')         { findChrome, trace } for tests

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const phone = require('../lib/gm-phone');
const { phonePage } = require('../lib/gm-phone-page');

const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const findChrome = () => CHROMES.find(p => p && fs.existsSync(p)) || null;

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const TOKEN = 't'.repeat(43);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- the scripted desk: four cards in a row, a say that asks back -------------------

const CARDS = {
  q1: { kind: 'question', question: { key: 'focus', ask: 'what matters most for this project this month?', line: 'installs dropped to 1,511 last week, down from 1,640.', choices: [{ id: 'money', label: 'making money from it' }, { id: 'users', label: 'more people using it' }, { id: 'other', label: 'something else', other: true }] } },
  b1: { kind: 'bet', bet: { title: 'Write a getting started page for the phone', why_now: 'installs last week were 1,400', expect: 'more people try it by nov 1' } },
  c1: { kind: 'choice', choice: { options: [{ id: 'o1', title: 'Record a two minute demo video', why: 'people trust what they can watch.' }, { id: 'o2', title: 'Send the weekly note to the twelve schools', why: 'they asked for it last week.' }] } },
  b2: { kind: 'bet', bet: { title: 'Record a two minute demo video', why_now: 'the readme has no video yet', expect: 'more installs from the readme by nov 1' } },
};
const REPLY = 'a short page that walks a new person from install to their first card, with one example.';

function scriptedDesk({ readMs = 150 } = {}) {
  const order = ['q1', 'b1', 'c1'];
  let at = 0;
  const card = id => ({ ok: true, status: 'ready', id, ...CARDS[id], team_working: 0 });
  let current = card(order[0]);
  return {
    warm: () => current,
    next: () => { at = Math.min(at + 1, order.length - 1); current = card(order[at]); return current; },
    answer: () => ({ ok: true, ack: 'got it.' }),
    report: () => ({ ok: true, ack: 'saved.' }),
    pick: () => { current = card('b2'); return current; },
    say: async ({ text }) => {
      await wait(readMs);
      if (/\?\s*$/.test(text)) return { ok: true, stay: true, kind: 'question', reply: REPLY, suggestions: ['sounds good', 'make it shorter'], thread: [{ who: 'owner', text }, { who: 'orb', text: REPLY }] };
      return { ok: true, ack: 'got it.' };
    },
    skip: () => ({ ok: true }),
    teamTable: () => ({ ok: true, rows: [] }),
  };
}

async function serve(desk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-trace-'));
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: dir,
    token: TOKEN,
    hosts,
    loadView: () => ({}),
    runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true,
    snapshotTarget: () => () => true,
    logPath: path.join(dir, 'gm-phone-actions.jsonl'),
    page: phonePage,
    makeBetDesk: () => desk,
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  return {
    url: `http://${base}/?t=${TOKEN}`,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

// ---- chrome over the devtools protocol --------------------------------------------

async function launch(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-trace-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--window-size=${PHONE.width},${PHONE.height}`, 'about:blank'];
  // linux runners often refuse chrome's sandbox; the page is our own, served locally
  if (process.platform === 'linux') args.push('--no-sandbox');
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const quit = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); };
  try {
    const port = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`chrome did not start: ${err.slice(-300)}`)), 15000);
      proc.stderr.on('data', d => {
        err += d;
        const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      proc.on('exit', code => { clearTimeout(timer); reject(new Error(`chrome exited ${code}: ${err.slice(-300)}`)); });
    });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('devtools socket failed')); });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      const w = msg.id && waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
    return { send, close: () => { try { ws.close(); } catch { /* closed */ } quit(); } };
  } catch (err) {
    quit();
    throw err;
  }
}

function driver(send) {
  const run = async (expr) => {
    const out = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`page: ${out.exceptionDetails.exception ? out.exceptionDetails.exception.description : out.exceptionDetails.text}`);
    return out.result.value;
  };
  const until = async (expr, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await run(expr)) return; await wait(16); }
    throw new Error(`waited ${ms}ms for ${what}`);
  };
  const rect = sel => run(`(function () { var n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  const tap = async (sel) => {
    const r = await rect(sel);
    if (!r) throw new Error(`nothing to tap at ${sel}`);
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const type = text => send('Input.insertText', { text });
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };
  return { run, until, rect, tap, type, enter };
}

// ---- the recorder: one row per frame, in the page ----------------------------------

const RECORDER = `(function () {
  var T = window.__trace = { frames: [], marks: [], on: true };
  // the moment the owner acts, from the page's own clock
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') T.marks.push({ what: 'enter', t: performance.now() }); }, true);
  document.addEventListener('click', function () { T.marks.push({ what: 'tap', t: performance.now() }); }, true);
  function r(n) { if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
  function op(n) { return n ? Number(getComputedStyle(n).opacity) : 0; }
  (function rec() {
    if (!T.on) return;
    var box = document.getElementById('bet');
    var ghost = document.querySelector('.bet.ghost');
    var spot = box.querySelector('.field, .chosen');
    var active = document.activeElement;
    T.frames.push({
      t: performance.now(),
      title: r(box.querySelector('h1')),
      titleText: box.querySelector('h1') ? box.querySelector('h1').textContent : '',
      boxOpacity: op(box),
      ghost: Boolean(ghost),
      ghostTitle: ghost ? r(ghost.querySelector('h1')) : null,
      ghostOpacity: op(ghost),
      spot: r(spot),
      spotChosen: Boolean(spot && spot.classList.contains('chosen')),
      spotBorder: spot ? getComputedStyle(spot).borderTopColor : null,
      typing: Boolean(spot && active && spot.contains(active) && active.tagName === 'INPUT'),
      // every row of the card under the title, in order: answers, links, the say line
      rows: Array.prototype.map.call(box.querySelectorAll('.act > *, .options > *, .sayline, :scope > .links'), function (n) { return { r: r(n), o: op(n), spot: Boolean(spot && (n === spot || n.contains(spot))) }; }),
      revealMs: document.body.getAttribute('data-reveal-ms'),
    });
    requestAnimationFrame(rec);
  })();
})()`;

// ---- the summary ------------------------------------------------------------------

// a missing element never reads as "did not move"
const dist = (a, b) => (a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : (a || b ? Infinity : 0));
const size = (a, b) => (a && b ? Math.max(Math.abs(a.w - b.w), Math.abs(a.h - b.h)) : Infinity);
const center = a => ({ x: a.x + a.w / 2, y: a.y + a.h / 2 });
const round = n => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const most = list => list.reduce((m, n) => Math.max(m, n), 0);

// One stretch, from the owner's first act (a tap that opens a field, or the
// tap that answers) to the next title at rest. marks: the page times of the
// acts in this stretch; the last one sends. before: the frame before them.
function summarize(frames, marks, before) {
  const opened = marks[0].t, sent = marks[marks.length - 1].t;
  const typing = frames.filter(f => f.t >= opened && f.t < sent);
  const after = frames.filter(f => f.t >= sent);
  const crossAt = after.findIndex(f => f.ghost);
  const holding = crossAt < 0 ? after : after.slice(0, crossAt);
  const crossing = crossAt < 0 ? [] : after.slice(crossAt);
  const spot0 = holding[0] && holding[0].spot;
  // the rest of the card, row by row against where it sat before the first act
  const othersMoved = f => most(f.rows.map((row, i) => (row.spot ? 0 : dist(row.r, before.rows[i] && before.rows[i].r))));
  const othersOpacity = f => (f ? most(f.rows.filter(row => !row.spot).map(row => row.o)) : null);
  // the next title: the new card's, once the crossfade starts, while it shows
  const titled = crossing.filter(f => f.title && f.boxOpacity > 0.05);
  // the old card's still copy, while it shows, sits exactly where the card was
  const ghosted = crossing.filter(f => f.ghost && f.ghostTitle && f.ghostOpacity > 0.05);
  let step = 0;
  for (let i = 1; i < holding.length; i++) step = Math.max(step, dist(holding[i].spot, holding[i - 1].spot));
  for (let i = 1; i < titled.length; i++) step = Math.max(step, dist(titled[i].title, titled[i - 1].title));
  const last = frames[frames.length - 1];
  return {
    others_dimmed_to: round(othersOpacity(typing[typing.length - 1] || holding[holding.length - 1])),
    others_moved_px: round(most([...typing, ...holding].map(othersMoved))),
    hold_ms: crossAt < 0 ? null : Math.round(after[crossAt].t - sent),
    held_as_chosen: holding.length > 0 && holding.every(f => f.spotChosen),
    held_moved_px: round(most(holding.map(f => dist(f.spot, spot0)))),
    ghost_title_px: ghosted.length ? round(most(ghosted.map(f => dist(f.ghostTitle, before.title)))) : null,
    title_max_px: titled.length ? round(most(titled.map(f => dist(f.title, before.title)))) : null,
    title_rest_px: round(dist(last.title, before.title)),
    largest_frame_step_px: round(step),
    next_title: last.titleText,
    reveal_ms: last.revealMs == null ? null : Number(last.revealMs),
  };
}

// ---- the run ------------------------------------------------------------------------

// the cursor sits in the typing spot itself, not in a box somewhere else
const CURSOR = "Boolean(document.querySelector('#bet .field') && document.querySelector('#bet .field').contains(document.activeElement) && document.activeElement.tagName === 'INPUT')";

async function trace({ chromePath = findChrome(), shots = null } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const desk = scriptedDesk();
  const server = await serve(desk);
  let chrome = null;
  try {
    chrome = await launch(chromePath);
    const { send } = chrome;
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await send('Page.enable');
    await send('Page.navigate', { url: server.url });
    const p = driver(send);
    const shot = async (name) => {
      if (!shots) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };
    const settled = "document.body.classList.contains('has-card') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning')";
    await p.until(`document.readyState === 'complete' && ${settled} && Boolean(document.querySelector('#bet h1'))`, 'the first card');
    await p.run(RECORDER);
    const frames = () => p.run('window.__trace.frames');
    const lastFrame = async () => { const f = await frames(); return f[f.length - 1]; };
    const results = [];
    // a stretch that never finishes stops the run; what came before is kept
    let failed = null;
    const stretch = async (name, act, done) => {
      if (failed) return { name, skipped: true };
      try {
        return await measure(name, act, done);
      } catch (err) {
        failed = `${name}: ${err.message}`;
        return { name, error: err.message };
      }
    };
    const measure = async (name, act, done) => {
      await wait(80);
      const before = await lastFrame();
      const seen = (await p.run('window.__trace.marks')).length;
      const out = { name };
      await act(out);
      const marks = (await p.run('window.__trace.marks')).slice(seen);
      await p.until(done, `${name} to finish`, 6000);
      await wait(120);
      return { ...out, ...summarize(await frames(), marks, before) };
    };

    // one: something else becomes the field in its spot, Enter holds it, the next card turns in
    results.push(await stretch('typed in place of something else', async (out) => {
      const button = await p.rect('#bet .choice:last-of-type');
      await p.tap('#bet .choice:last-of-type');
      await wait(250);
      const field = await p.rect('#bet .field');
      out.field_vs_button_px = { moved: round(dist(field, button)), resized: round(size(field, button)) };
      out.cursor_in_field = await p.run(CURSOR);
      await p.type('paying schools');
      await shot('1-typing');
      await p.enter();
      await wait(150);
      await shot('2-held');
    }, `${settled} && document.body.hasAttribute('data-reveal-ms')`));

    // two: or say something becomes the field in its own spot; a question back
    // gets a reply in the title's spot with its suggestions where the answers go
    results.push(await stretch('said something, got a reply', async (out) => {
      const button = await p.rect('#bet .sayline .quiet');
      await p.tap('#bet .sayline .quiet');
      await wait(250);
      const field = await p.rect('#bet .field');
      const a = center(button), b = field ? center(field) : { x: Infinity, y: Infinity };
      out.field_vs_button_px = { center_moved: round(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))), height_change: round(field ? Math.abs(field.h - button.h) : Infinity) };
      out.cursor_in_field = await p.run(CURSOR);
      await p.type('what do you mean?');
      await shot('3-say-typing');
      await p.enter();
      await wait(150);
      await shot('4-say-held');
    }, `${settled} && document.querySelector('#bet h1') && document.querySelector('#bet h1').textContent === ${JSON.stringify(REPLY)}`));
    await shot('5-reply');
    if (!failed) results[1].suggestions = await p.run("Array.prototype.map.call(document.querySelectorAll('#bet .act .choice'), function (n) { return n.textContent; })");

    // three: a tapped suggestion holds as chosen, then the next card turns in
    await p.run("document.body.removeAttribute('data-reveal-ms')");
    results.push(await stretch('tapped a suggested reply', async () => {
      await p.tap('#bet .act .choice:first-child');
      await wait(150);
      await shot('6-suggestion-held');
    }, `${settled} && document.body.hasAttribute('data-reveal-ms')`));

    // four: a tapped option on a choice of ideas holds, then its card turns in
    await p.run("document.body.removeAttribute('data-reveal-ms')");
    results.push(await stretch('tapped an idea', async () => {
      await p.tap('#bet .option:first-child');
      await wait(150);
      await shot('7-idea-held');
    }, `${settled} && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b2.bet.title)}`));

    await shot('8-next');
    await p.run('window.__trace.on = false');
    return { viewport: `${PHONE.width}x${PHONE.height}`, frames: (await frames()).length, failed, stretches: results };
  } finally {
    if (chrome) chrome.close();
    await server.close();
  }
}

// ---- Esc on the team page: one layer back per press --------------------------------

const TEAM_ROWS = [{ member: 'builder', role: 'builder', ovr: '91', engine: 'claude opus 5.5', status: 'stopped', sentence: 'stopped: the getting started page, stopped 2 hours ago', on: 'the getting started page', time: 'stopped 2 hours ago' }];

// what is showing: the team page or not, its title, its rows, the talk
// field's words and whether the cursor is in it, the card under it
const LAYER = `(function () {
  var team = document.getElementById('team');
  var field = team.querySelector('input');
  var send = team.querySelector('.sayline .pill');
  var card = document.querySelector('#bet h1');
  return {
    team_open: !team.hidden,
    team_title: !team.hidden && team.querySelector('h1') ? team.querySelector('h1').textContent : null,
    rows: team.hidden ? 0 : team.querySelectorAll('.row').length,
    field_words: field ? field.value : null,
    typing: Boolean(field && document.activeElement === field),
    send_says: send ? send.textContent : null,
    card_title: card ? card.textContent : null,
    card_field_open: Boolean(document.querySelector('#bet .field')),
  };
})()`;

// The real page on a phone-size headless Chrome (or the viewport given),
// served with this desk and at rest on its first card. fn(p, send) drives
// it; Chrome and the server are closed after, whatever happens.
async function onPhone(desk, chromePath, fn, viewport = PHONE) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serve(desk);
  let chrome = null;
  try {
    chrome = await launch(chromePath);
    const { send } = chrome;
    await send('Emulation.setDeviceMetricsOverride', viewport);
    await send('Page.enable');
    await send('Page.navigate', { url: server.url });
    const p = driver(send);
    await p.until(`document.readyState === 'complete' && ${SETTLED} && Boolean(document.querySelector('#bet h1'))`, 'the first card');
    return await fn(p, send);
  } finally {
    if (chrome) chrome.close();
    await server.close();
  }
}

const SETTLED = "document.body.classList.contains('has-card') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning')";

// a tap on the button that reads label, wherever it sits on the card
async function tapLabel(p, send, label) {
  const r = await p.run(`(function () { var n = Array.prototype.find.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent === ${JSON.stringify(label)}; }); if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`no button reads ${label}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
}

// Opens the team from the card, a member's talk card from a row, types a
// word to them that arms a second tap, then presses Esc until the card is
// back and once more. Each step reads the layer, so "Esc steps back one
// layer" is a list of states.
async function escapeTrace({ chromePath = findChrome() } = {}) {
  const desk = { ...scriptedDesk(), teamTable: () => ({ ok: true, rows: TEAM_ROWS }), talk: ({ confirm }) => (confirm ? { ok: true, ack: 'builder has it.' } : { ok: false, reason: 'needs_confirm', message: 'tap again to start builder on this' }) };
  return onPhone(desk, chromePath, async (p, send) => {
    const steps = [];
    const look = async (did) => { await wait(120); steps.push({ did, ...(await p.run(LAYER)) }); };
    const esc = async () => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    };
    await look('the card');
    await esc();
    await look('esc on the card');
    await p.tap('#working');
    await p.until("Boolean(document.querySelector('#team .row'))", 'the team rows');
    await look('tapped the team');
    await p.tap('#team .row .who button');
    await p.until("Boolean(document.querySelector('#team input'))", 'the talk card');
    await p.tap('#team input');
    await p.type('take the readme first');
    await p.enter();
    await p.until("document.querySelector('#team .sayline .pill').textContent === 'tap again'", 'the armed second tap');
    await look('typing to builder');
    for (let i = 1; i <= 4; i++) { await esc(); await look(`esc ${i}`); }
    return { viewport: `${PHONE.width}x${PHONE.height}`, steps };
  });
}

// ---- an answer goes to the question on screen, or nowhere ---------------------------

// two questions whose answers share ids, as written questions do: a2 is
// "small teams" on the first and "fewer mistakes" on the second
const STALE = {
  q1: { kind: 'question', question: { key: 'q1', ask: 'who uses the phone page most?', line: 'the phone page went live this week.', choices: [{ id: 'a1', label: 'solo founders' }, { id: 'a2', label: 'small teams' }] } },
  q2: { kind: 'question', question: { key: 'q2', ask: 'what would make a small team pay?', line: 'installs dropped to 1,511 last week.', choices: [{ id: 'a1', label: 'saving them hours' }, { id: 'a2', label: 'fewer mistakes' }] } },
};

// The owner answers the first question. The desk saves it and moves to the
// second, but the page never hears back. The owner taps the same answer on
// the old card, still on screen. The desk refuses an answer that names a
// card other than its own, as the real one does, and saves the rest.
async function staleAnswerTrace({ chromePath = findChrome() } = {}) {
  const card = id => ({ ok: true, status: 'ready', id: `question:${id}`, ...STALE[id], team_working: 0 });
  let current = card('q1');
  const posts = [];
  const saved = [];
  const desk = {
    ...scriptedDesk(),
    warm: () => current,
    answer: ({ choice, card: named }) => {
      posts.push({ choice, card: named === undefined ? null : named });
      if (!current) return { ok: false, reason: 'gone', message: 'there is no question on screen' };
      if (named !== undefined && named !== current.id) return { ok: false, reason: 'gone', message: 'that card changed, so nothing was saved. tap the orb for the new one' };
      const picked = current.question.choices.find(c => c.id === choice);
      saved.push({ question: current.question.ask, answer: picked.label });
      current = null;
      return { ok: true, ack: `got it: ${picked.label}.` };
    },
    // the next card is made, then the reply to the page is lost
    next: () => { current = card('q2'); throw new Error('the reply was lost'); },
  };
  return onPhone(desk, chromePath, async (p, send) => {
    const shown = () => p.run("document.querySelector('#bet h1').textContent");
    await tapLabel(p, send, 'small teams');
    await p.until("document.getElementById('line').textContent === 'that did not go through. tap to try again' && !document.getElementById('bet').classList.contains('holding')", 'the lost next card');
    const after_lost = await shown();
    await tapLabel(p, send, 'small teams');
    // the second tap reaches the desk, and its answer has come back
    const end = Date.now() + 3000;
    while (posts.length < 2 && Date.now() < end) await wait(16);
    await wait(HOLD_WAIT_MS);
    const hint = await p.run("(function () { var n = document.querySelector('#bet .act .links'); return n ? n.textContent : null; })()");
    return { title_after_lost: after_lost, title_at_end: await shown(), hint, posts, saved };
  });
}

// ---- words that did not send stay in the box ----------------------------------------

// The owner types in "or say something". The first send never leaves the
// phone (the network is off), the second reaches a desk that could not pass
// it on, the third goes through. After each failure: is the box still
// there, with the words and the cursor in it, and what does the line say.
async function unsentSayTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'please use the short introduction I wrote';
  const card = id => ({ ok: true, status: 'ready', id, ...CARDS[id], team_working: 0 });
  let current = card('b1');
  const calls = [];
  const desk = {
    ...scriptedDesk(),
    warm: () => current,
    say: ({ text, card: named }) => {
      calls.push({ text, card: named === undefined ? null : named });
      if (calls.length === 1) return { ok: false, reason: 'steer_failed', message: 'it did not reach them. try again in a minute.' };
      return { ok: true, ack: 'got it.' };
    },
    next: () => { current = card('b2'); return current; },
  };
  return onPhone(desk, chromePath, async (p, send) => {
    const look = () => p.run(`(function () { var field = document.querySelector('#bet .field'); var input = field && field.querySelector('input'); var note = document.querySelector('#bet .unsent'); return { field_open: Boolean(field), words: input ? input.value : null, cursor_in_field: Boolean(input && document.activeElement === input), held: Boolean(field && field.classList.contains('chosen')), line: note ? note.textContent : null, title: document.querySelector('#bet h1').textContent }; })()`);
    // after a send: the hold, then whatever the page does with the answer
    const settle = async () => { await wait(HOLD_WAIT_MS); await p.until(`${SETTLED} && !document.getElementById('bet').classList.contains('holding')`, 'the card at rest'); await wait(150); };
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(WORDS);
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p.enter();
    await settle();
    const offline = await look();
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p.enter();
    await settle();
    const refused = await look();
    await p.enter();
    // a box that is gone sends nothing, so the next card may never come
    await p.until(`${SETTLED} && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b2.bet.title)}`, 'the next card', 4000).catch(() => {});
    const sent = await look();
    return { words: WORDS, shown_card: 'b1', offline, refused, sent, calls };
  });
}
const HOLD_WAIT_MS = 900;

// ---- a word to a teammate that did not send comes back, ready to send again ----------

// On the team page the owner writes to builder. The first send never
// leaves the phone (the network is off). The second reaches the desk, but
// the reply back is lost. The third goes through. After each failure: the
// words, the send button, and the line under them. Every post the page
// made and every word the desk passed on are kept.
async function talkFailTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'take the readme first';
  const took = [];
  const desk = { ...scriptedDesk(), teamTable: () => ({ ok: true, rows: TEAM_ROWS }), talk: ({ text }) => { took.push(text); return { ok: true, ack: 'builder has it.' }; } };
  return onPhone(desk, chromePath, async (p, send) => {
    const look = () => p.run("(function () { var team = document.getElementById('team'); var input = team.querySelector('input'); var go = team.querySelector('.sayline .pill'); var reply = team.querySelector('.sayline .reply'); var done = team.querySelector('.mission'); return { words: input ? input.value : null, send_works: Boolean(go && !go.disabled), line: reply && !reply.hidden ? reply.textContent : null, done: done ? done.textContent : null }; })()");
    const net = offline => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // the page's own fetch: every word to a teammate is kept, and the reply to the second one never arrives
    await p.run("(function () { var real = window.fetch; window.__talks = []; window.fetch = function (url, opts) { var go = real(url, opts); if (String(url).indexOf('/bet/steer') < 0) return go; window.__talks.push(JSON.parse(opts.body)); if (window.__talks.length !== 2) return go; return go.then(function () { throw new TypeError('Failed to fetch'); }); }; })()");
    await p.tap('#working');
    await p.until("Boolean(document.querySelector('#team .row'))", 'the team rows');
    await p.tap('#team .row .who button');
    await p.until("Boolean(document.querySelector('#team input'))", 'the talk card');
    await p.tap('#team input');
    await p.type(WORDS);
    await send('Network.enable');
    await net(true);
    await p.enter();
    await wait(600);
    const offline = await look();
    await net(false);
    await p.enter();
    await wait(600);
    const lost = await look();
    await p.enter();
    await p.until("Boolean(document.querySelector('#team .mission'))", 'builder has it', 3000).catch(() => {});
    const sent = await look();
    return { words: WORDS, offline, lost, sent, posts: await p.run('window.__talks'), took };
  });
}

// ---- an explanation keeps the card's own answer ------------------------------------

const YES_CARD = { kind: 'yes', job: { what: 'builder wants to send the weekly note to the twelve schools', why: 'it goes out from your account, so it waits for your yes.' } };

// On a card with a "do it" (an idea) and on one with a "yes" (a step that
// waits for the owner), the owner asks what it means. The reply comes, and
// the card's own button must still be there and still work: two taps, and
// the desk is asked to do it or hears the yes.
async function replyKeepsActionTrace({ chromePath = findChrome() } = {}) {
  const runs = [];
  for (const [id, cardBody, label, armed] of [['b1', CARDS.b1, 'do it', 'tap again to start'], ['yes:y1', YES_CARD, 'yes', 'tap again to say yes']]) {
    const did = [];
    const current = { ok: true, status: 'ready', id, ...cardBody, team_working: 0 };
    const desk = {
      ...scriptedDesk(),
      warm: () => current,
      next: () => current,
      doIt: async () => { did.push('do it'); return { ok: true, ack: 'started.' }; },
      answerYes: async () => { did.push('yes'); return { ok: true, ack: 'sent.' }; },
    };
    runs.push(await onPhone(desk, chromePath, async (p, send) => {
      const buttons = () => p.run("Array.prototype.map.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent; })");
      await p.tap('#bet .sayline .quiet');
      await wait(250);
      await p.type('what do you mean?');
      await p.enter();
      await p.until(`${SETTLED} && document.querySelector('#bet h1').textContent === ${JSON.stringify(REPLY)}`, 'the reply');
      await wait(150);
      const after_reply = await buttons();
      let error = null;
      try {
        await tapLabel(p, send, label);
        await p.until(`Array.prototype.some.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent === ${JSON.stringify(armed)}; })`, 'the armed tap', 2000);
        await tapLabel(p, send, armed);
        const end = Date.now() + 3000;
        while (!did.length && Date.now() < end) await wait(16);
      } catch (err) { error = err.message; }
      return { card: id, label, after_reply, did, error };
    }));
  }
  return runs;
}

// ---- the small orb on a card goes back to the big one ------------------------------

// On an idea, and on the calm line while the next idea is written, the
// owner taps the small orb at the top. Where the page ends up, and whether
// it asked for a new card; then a tap on the big orb. On the calm line the
// idea lands while the owner is on the big orb, and waits there.
async function orbHomeTrace({ chromePath = findChrome() } = {}) {
  const runs = [];
  const idea = { ok: true, status: 'ready', id: 'b1', ...CARDS.b1, team_working: 0 };
  const next = { ok: true, status: 'ready', id: 'b2', ...CARDS.b2, team_working: 0 };
  const calm = { ok: true, status: 'ready', id: 'wait:1', kind: 'wait', job: { what: 'writing your next idea.' }, team_working: 0 };
  for (const from of ['idea', 'calm']) {
    let current = from === 'idea' ? idea : calm;
    let asked = 0;
    let landed = false;
    // as the real desk does: the calm line stays the card, with the idea ready behind it
    const desk = { ...scriptedDesk(), warm: () => (current === calm ? { ...calm, queue: landed ? 1 : 0 } : current), next: () => { asked += 1; current = current === calm && landed ? idea : next; return current; } };
    runs.push(await onPhone(desk, chromePath, async (p) => {
      const look = () => p.run("(function () { var h = document.querySelector('#bet h1'); return { has_card: document.body.classList.contains('has-card'), big_orb: getComputedStyle(document.querySelector('.stage')).display !== 'none' && getComputedStyle(document.getElementById('orb')).visibility !== 'hidden', line: document.getElementById('line').textContent, title: document.body.classList.contains('has-card') && h ? h.textContent : null }; })()");
      await p.tap('#lava');
      await p.until("!document.body.classList.contains('has-card')", 'the big orb', 4000).catch(() => {});
      await wait(600);
      const home = { ...(await look()), asked };
      // the idea lands while the owner is on the big orb
      if (from === 'calm') { landed = true; await wait(3500); }
      const stayed = { ...(await look()), asked };
      await p.tap('#orb');
      await p.until("document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1'))", 'a card', 8000).catch(() => {});
      await wait(400);
      const tapped = { ...(await look()), asked };
      return { from, home, stayed, tapped };
    }));
  }
  return runs;
}

// ---- a start that did not get going comes back to do it ----------------------------

// The owner asks what an idea means, then taps do it twice. The first start
// does not get going; the second does. After the failed one: what the card
// shows, its buttons, and the line under do it.
async function startFailTrace({ chromePath = findChrome() } = {}) {
  const current = { ok: true, status: 'ready', id: 'b1', ...CARDS.b1, team_working: 0 };
  const starts = [];
  const desk = {
    ...scriptedDesk(),
    warm: () => current,
    doIt: async () => {
      starts.push(starts.length + 1);
      if (starts.length === 1) return { ok: false, reason: 'start_failed', message: 'it did not get going. try again in a minute.' };
      return { ok: true, ack: 'started.' };
    },
  };
  return onPhone(desk, chromePath, async (p, send) => {
    const look = () => p.run("(function () { var box = document.getElementById('bet'); var note = box.querySelector('.unsent'); return { title: box.querySelector('h1').textContent, starting: /starting now/.test(box.textContent), buttons: Array.prototype.map.call(box.querySelectorAll('button'), function (b) { return b.textContent; }), line: note ? note.textContent : null }; })()");
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type('what do you mean?');
    await p.enter();
    await p.until(`${SETTLED} && document.querySelector('#bet h1').textContent === ${JSON.stringify(REPLY)}`, 'the reply');
    await wait(150);
    await tapLabel(p, send, 'do it');
    await wait(100);
    await tapLabel(p, send, 'tap again to start');
    const end = Date.now() + 3000;
    while (starts.length < 1 && Date.now() < end) await wait(16);
    await wait(1500);
    const failed = await look();
    let error = null;
    try {
      await tapLabel(p, send, 'do it');
      await wait(100);
      await tapLabel(p, send, 'tap again to start');
      const again = Date.now() + 3000;
      while (starts.length < 2 && Date.now() < again) await wait(16);
    } catch (err) { error = err.message; }
    return { failed, starts: starts.length, error };
  });
}

// ---- a send that went through is never sent twice -----------------------------------

// The owner says something on an idea. It reaches the desk, but the reply
// back to the phone is lost, so the words stay in the box. The owner hits
// Enter again. Then, on the next card, the owner says something new. Every
// post the page made and every send the desk took are kept.
async function lostReplyTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'add the short demo too';
  const NEW = 'and send it to the twelve schools';
  const card = id => ({ ok: true, status: 'ready', id, ...CARDS[id], team_working: 0 });
  let current = card('b1');
  const took = [];
  const desk = {
    ...scriptedDesk(),
    warm: () => current,
    say: ({ text }) => { took.push(text); return { ok: true, ack: 'sent to builder.' }; },
    next: () => { current = card(current.id === 'b1' ? 'b2' : 'b1'); return current; },
  };
  return onPhone(desk, chromePath, async (p) => {
    // the page's own fetch: every say is kept, and the first one's reply never arrives
    await p.run(`(function () { var real = window.fetch; window.__says = []; window.fetch = function (url, opts) { var go = real(url, opts); if (String(url).indexOf('/bet/say') < 0) return go; window.__says.push(JSON.parse(opts.body)); if (window.__says.length > 1) return go; return go.then(function () { throw new TypeError('Failed to fetch'); }); }; })()`);
    const title = t => `${SETTLED} && document.querySelector('#bet h1').textContent === ${JSON.stringify(t)}`;
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(WORDS);
    await p.enter();
    await wait(HOLD_WAIT_MS);
    await p.until(`${SETTLED} && !document.getElementById('bet').classList.contains('holding')`, 'the lost reply');
    const kept = await p.run("(function () { var i = document.querySelector('#bet .field input'); return i ? i.value : null; })()");
    await p.enter();
    await p.until(title(CARDS.b2.bet.title), 'the next card', 6000).catch(() => {});
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(NEW);
    await p.enter();
    await p.until(title(CARDS.b1.bet.title), 'the card after', 6000).catch(() => {});
    return { words: WORDS, new_words: NEW, kept, posts: await p.run('window.__says'), took };
  });
}

// ---- the team table at phone and laptop width ---------------------------------------

const LAPTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

// a real-sized team: long roles and statuses, a rookie, and no rating or model
const TABLE_ROWS = [
  { member: 'navigator', role: 'system navigator', ovr: '84', engine: 'claude haiku 5.5', status: 'waiting for your yes', sentence: 'waiting for your yes: plan the pricing page, waiting 2 hours', on: 'Plan the pricing page', time: 'waiting 2 hours' },
  { member: 'builder', role: 'builder', ovr: '91', engine: 'claude opus 5.5', status: 'working', sentence: 'working: launch a try page for any public repo, about 4 hours left', on: 'Launch a try page for any public repo', time: 'about 4 hours left' },
  { member: 'auto-improver', role: 'continuous improver', ovr: 'new', engine: 'claude opus 5.5', status: 'stopped', sentence: 'stopped: split the big test file so each part runs alone, stopped 30 minutes ago', on: 'Split the big test file so each part runs alone', time: 'stopped 30 minutes ago' },
  { member: 'linguist', role: 'linguist, operator language and understanding', ovr: '\u00b7\u00b7', engine: '\u00b7\u00b7', status: 'idle', sentence: 'idle: no work in the last day', on: '', time: '' },
  { member: 'validator', role: 'reviewer', ovr: '89', engine: 'codex gpt-6.1-sol', status: 'idle', sentence: 'idle: no work in the last day', on: '', time: '' },
];

// what the table looks like on screen: the column names, whether any cell's
// words spill out of it, every inner line, the side scroll, where the name
// column sits once scrolled, and whether anything on it moves
const TABLE_LOOK = `(function () {
  var team = document.getElementById('team');
  var grid = team.querySelector('.grid');
  var table = team.querySelector('table');
  if (!grid || !table) return null;
  var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (n) { return n.textContent; });
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  var spills = [], lines = { inner_right: 0, missing_right: 0, inner_bottom: 0, missing_bottom: 0 }, oneLine = [], moving = [];
  var widths = {};
  rows.forEach(function (tr, ri) {
    Array.prototype.forEach.call(tr.children, function (td, ci) {
      var cs = getComputedStyle(td);
      if (td.scrollWidth > td.clientWidth + 1) spills.push(heads[ci] + ' of ' + tr.querySelector('.who').textContent);
      if (ci < tr.children.length - 1) { if (cs.borderRightWidth === '1px') lines.inner_right += 1; else lines.missing_right += 1; }
      if (ri < rows.length - 1) { if (cs.borderBottomWidth === '1px') lines.inner_bottom += 1; else lines.missing_bottom += 1; }
      var w = td.getBoundingClientRect().width;
      widths[heads[ci]] = Math.min(widths[heads[ci]] == null ? Infinity : widths[heads[ci]], Math.round(w));
      if (['member', 'ovr', 'engine'].indexOf(heads[ci]) >= 0) {
        var lh = parseFloat(cs.lineHeight) || 24;
        var text = td.querySelector('button') || td;
        var r = document.createRange(); r.selectNodeContents(text);
        if (r.getClientRects().length > 1) oneLine.push(heads[ci] + ' of ' + tr.querySelector('.who').textContent);
      }
      if (cs.animationName !== 'none' || parseFloat(cs.transitionDuration) > 0 || cs.boxShadow !== 'none') moving.push(heads[ci]);
    });
  });
  var g = grid.getBoundingClientRect();
  var before = table.querySelector('tbody .who').getBoundingClientRect().left;
  grid.scrollLeft = 200;
  var scrolled = grid.scrollLeft;
  var after = table.querySelector('tbody .who').getBoundingClientRect().left;
  grid.scrollLeft = 0;
  var sizes = Array.prototype.map.call(table.querySelectorAll('th, td, td button'), function (n) { return parseFloat(getComputedStyle(n).fontSize); });
  return {
    heads: heads,
    rows: rows.length,
    spills: spills,
    lines: lines,
    wrapped: oneLine,
    moving: moving,
    narrowest: widths,
    grid_width: Math.round(g.width),
    table_width: Math.round(table.getBoundingClientRect().width),
    scrolls_sideways: grid.scrollWidth > grid.clientWidth + 1,
    scrolled_by: Math.round(scrolled),
    name_column_moved_px: Math.round(Math.abs(after - before)),
    page_scrolls_sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    smallest_font_px: Math.min.apply(null, sizes),
    statuses: Array.prototype.map.call(table.querySelectorAll('tbody td.st'), function (n) { return n.textContent; }),
  };
})()`;

// Opens the team table at one viewport, reads TABLE_LOOK, then taps a
// member's role cell (the part of a row that is always on screen), reads
// the talk card, and presses Esc twice: back to the table, then closed.
// With shots, saves the table as a png named for the viewport.
async function teamTableTrace({ chromePath = findChrome(), viewport = PHONE, shots = null, rows = TABLE_ROWS } = {}) {
  const desk = { ...scriptedDesk(), teamTable: () => ({ ok: true, rows }), talk: () => ({ ok: true, ack: 'sent.' }) };
  return onPhone(desk, chromePath, async (p, send) => {
    const esc = async () => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await wait(120);
    };
    const layer = () => p.run("(function () { var team = document.getElementById('team'); return { open: !team.hidden, title: team.hidden ? null : team.querySelector('h1').textContent, table: Boolean(team.querySelector('table')), said: team.querySelector('p.why') ? team.querySelector('p.why').textContent : null }; })()");
    await p.tap('#working');
    await p.until("Boolean(document.querySelector('#team tbody tr'))", 'the team table');
    await wait(100);
    const look = await p.run(TABLE_LOOK);
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, `team-${viewport.width}x${viewport.height}.png`), Buffer.from(shot.data, 'base64'));
    }
    await p.tap('#team tbody tr:nth-child(2) .role');
    await p.until("Boolean(document.querySelector('#team input'))", 'the talk card');
    const talk = await layer();
    await esc();
    const back = await layer();
    await esc();
    const closed = await layer();
    return { viewport: `${viewport.width}x${viewport.height}`, look, talk, back, closed };
  }, viewport);
}

module.exports = { findChrome, trace, escapeTrace, staleAnswerTrace, unsentSayTrace, replyKeepsActionTrace, lostReplyTrace, talkFailTrace, startFailTrace, orbHomeTrace, teamTableTrace, onPhone, scriptedDesk, CARDS, REPLY, PHONE, LAPTOP };

if (require.main === module) {
  const at = process.argv.indexOf('--shots');
  const shots = at > 0 ? path.resolve(process.argv[at + 1] || 'gm-phone-shots') : null;
  const fail = (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); };
  if (process.argv.includes('--team')) {
    (async () => {
      const out = [];
      for (const viewport of [PHONE, LAPTOP]) out.push(await teamTableTrace({ viewport, shots }));
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    })().catch(fail);
  } else {
    trace({ shots }).then((out) => {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      if (out.failed) process.exitCode = 1;
    }, fail);
  }
}

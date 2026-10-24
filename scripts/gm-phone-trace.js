#!/usr/bin/env node
'use strict';

// Frame traces of the gm phone page in headless Chrome at phone size. Each
// serves the real page through the real phone handler with a desk that
// speaks the one card contract (lib/gm-card.js), drives it with real
// pointer and key events, and reads what the page shows. The main trace
// records every frame where the card's title, the typing spot, and each
// option sit, so "the eyes stay in one place" is a number. Node built-ins
// and a local Chrome only; Chrome starts through lib/headless-chrome.js.
//
//   node scripts/gm-phone-trace.js              prints the summary as json
//   node scripts/gm-phone-trace.js --shots DIR  also saves a phone screenshot
//                                               at each moment (slows frames;
//                                               read the numbers from a plain run)
//   node scripts/gm-phone-trace.js --wait       a typed answer, got it, the calm
//                                               line, a note, and the idea out of
//                                               the dots, then the same under
//                                               reduced motion (--shots DIR too)
//   node scripts/gm-phone-trace.js --team       the team card at phone and
//                                               laptop size (--shots DIR saves both)
//   node scripts/gm-phone-trace.js --engine     the swap card from the team
//                                               card, a swap, and the team after
//   require('./scripts/gm-phone-trace')         { findChrome, trace, ... } for tests

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const phone = require('../lib/gm-phone');
const gmCard = require('../lib/gm-card');
const { phonePage } = require('../lib/gm-phone-page');
const { makeProfileDir, removeProfileDir, headlessArgs } = require('../lib/headless-chrome');

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
const LAPTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const TOKEN = 't'.repeat(43);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- a desk with the real desk's card rules -------------------------------------------

// It serves one gm-card card at a time and keeps the real desk's rules: an
// act that names another card, or an option the card does not have, is
// refused with the card on screen; an option that wants a second tap asks
// for it. Every other act goes to on(action, { body, card, option, text }),
// which answers with { card, ack, home } for the next card, or { ok: false,
// reason, message } to refuse and keep this one. extra.queue and extra.needs
// are the counts the page reads around the card.
function cardDesk(first, on, extra = {}) {
  let current = first;
  const env = (over = {}) => ({ ok: true, ...over, card: gmCard.wire(current), status: current ? 'ready' : 'idle', queue: extra.queue ? extra.queue() : 0, team_working: 0, needs_you: extra.needs ? extra.needs() : 0 });
  const refuse = (reason, message) => ({ status: 409, body: { ...env(), ok: false, reason, message } });
  const apply = (out) => {
    if (!out || out.ok === false) return refuse((out && out.reason) || 'gone', (out && out.message) || 'that did not go through. try again.');
    if ('card' in out) current = out.card;
    return { status: 200, body: env({ ...(out.ack ? { ack: out.ack } : {}), ...(out.home ? { home: true } : {}) }) };
  };
  return {
    get current() { return current; },
    set current(c) { current = c; },
    card: () => env(),
    act: async (body) => {
      if (body.orb) {
        if (body.card_id && current && body.card_id !== current.id) return { status: 200, body: env() };
        return apply(await on('orb', { body, card: current }));
      }
      if (body.open) return apply(await on(`open:${body.open}`, { body, card: current }));
      if (!current || !body.card_id || body.card_id !== current.id) return refuse('gone', 'that card changed, so nothing was done. here is the one on screen now');
      const option = body.option_id ? current.options.find(o => o.id === body.option_id) : null;
      if (body.option_id && !option) return refuse('bad_option', 'that is not on this card');
      if (option && option.confirm && body.confirm !== true) return refuse('needs_confirm', option.confirm);
      const action = option ? option.action : current.input && current.input.action;
      const text = body.text || (option && option.binds && option.binds.text) || '';
      return apply(await on(action, { body, card: current, option, text }));
    },
  };
}

// ---- the cards the traces walk ---------------------------------------------------------

const CARDS = {
  q1: gmCard.question({ id: 'question:focus', title: 'what matters most for this project this month?', body: 'installs dropped to 1,511 last week, down from 1,640.', choices: [{ id: 'money', label: 'making money from it' }, { id: 'users', label: 'more people using it' }, { id: 'other', label: 'something else', other: true }] }),
  b1: gmCard.idea({ id: 'bet-1', title: 'Write a getting started page for the phone', body: 'installs last week were 1,400. more people try it by nov 1.' }),
  c1: gmCard.choice({ id: 'choice:o1,o2', items: [{ id: 'o1', title: 'Record a two minute demo video', why: 'people trust what they can watch.' }, { id: 'o2', title: 'Send the weekly note to the twelve schools', why: 'they asked for it last week.' }] }),
  b2: gmCard.idea({ id: 'bet-2', title: 'Record a two minute demo video', body: 'the readme has no video yet. more installs from the readme by nov 1.' }),
  yes: gmCard.yes({ id: 'yes:m1:step-3:abc', title: 'builder wants to send the weekly note to the twelve schools', body: 'it goes out from your account, so it waits for your yes.', request: { job: 'm1', key: 'm1:step-3:abc', hash: 'abc' } }),
  calm: gmCard.wait({ id: 'wait:1' }),
};
const REPLY = 'a short page that walks a new person from install to their first card, with one example.';
const replyTo = (card, n = 1) => gmCard.reply({ id: `${card.id}~r${n}`, base: card, text: REPLY, suggestions: ['sounds good', 'make it shorter'] });

// four cards in a row: a question, an idea, a choice of ideas, the picked idea;
// words that end in a question mark get a reply that explains
function scriptedDesk({ readMs = 150 } = {}) {
  const after = { [CARDS.q1.id]: CARDS.b1, [CARDS.b1.id]: CARDS.c1, [CARDS.c1.id]: CARDS.c1, [CARDS.b2.id]: CARDS.b2 };
  const nextOf = card => (card && card.kind === 'reply' ? CARDS.c1 : after[card && card.id] || CARDS.b1);
  return cardDesk(CARDS.q1, async (action, { card, text }) => {
    if (action === 'say') {
      await wait(readMs);
      if (/\?\s*$/.test(text)) return { card: replyTo(card) };
      return { card: nextOf(card) };
    }
    if (action === 'pick') return { card: CARDS.b2 };
    return { card: nextOf(card) };
  });
}

async function serve(desk, page = phonePage) {
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
    page,
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

// The first chrome in a busy CI shard can take well over 15s to come up cold.
const CHROME_START_MS = 45000;

async function launch(chromePath) {
  const profile = makeProfileDir('gm-trace-chrome-');
  const args = headlessArgs(profile, ['--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--window-size=${PHONE.width},${PHONE.height}`, 'about:blank']);
  // linux runners often refuse chrome's sandbox; the page is our own, served locally
  if (process.platform === 'linux') args.push('--no-sandbox');
  // mac: a fresh profile asks the login keychain for chrome's storage key and pops a dialog; use a throwaway key instead
  if (process.platform === 'darwin') args.push('--use-mock-keychain', '--password-store=basic');
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const quit = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } removeProfileDir(profile); };
  try {
    const port = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`chrome did not start in ${CHROME_START_MS / 1000}s: ${err.slice(-300)}`)), CHROME_START_MS);
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
    var spot = box.querySelector('.field, .chosen');
    var active = document.activeElement;
    T.frames.push({
      t: performance.now(),
      title: r(box.querySelector('h1')),
      titleText: box.querySelector('h1') ? box.querySelector('h1').textContent : '',
      card: box.getAttribute('data-card'),
      boxOpacity: op(box),
      hasCard: document.body.classList.contains('has-card') && !box.hidden,
      leaving: box.classList.contains('leave'),
      sphere: getComputedStyle(document.querySelector('.stage')).display !== 'none' && getComputedStyle(document.getElementById('orb')).visibility !== 'hidden',
      spot: r(spot),
      spotChosen: Boolean(spot && spot.classList.contains('chosen')),
      typing: Boolean(spot && active && spot.contains(active) && active.tagName === 'INPUT'),
      // every row of the card under the title, in order: the options and the box
      rows: Array.prototype.map.call(box.querySelectorAll('.act > *, .act .links > button, .sayline'), function (n) { return { r: r(n), o: op(n), spot: Boolean(spot && (n === spot || n.contains(spot) || spot.contains(n))) }; }),
      revealMs: document.body.getAttribute('data-reveal-ms'),
      revealPlan: document.body.getAttribute('data-reveal-plan'),
      revealWaited: document.body.getAttribute('data-reveal-waited-ms'),
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
const num = v => (v == null ? null : Number(v));

// The page's own account of a reveal: the clock from the tap to the card
// fully in, and the motion's steps with the length each is set to take
// ("hold 150, glide 260, ..."). What the clock reads past the motion is the
// wait on the desk's answer and then late timers and frames, which a busy
// machine stretches. slowest_frame_ms is the longest gap between two frames
// on the way, and pace_frame_ms the 75th percentile of the frames that draw
// the dots: those are the frames a slow machine slows (the rest stay near
// 60fps even 16 times slower), and a few stalls cannot move it.
function reveal(frames, sent) {
  const last = frames[frames.length - 1];
  const motion = last.revealPlan == null ? null : last.revealPlan.split(', ').filter(Boolean).map(s => {
    const at = s.lastIndexOf(' ');
    return [s.slice(0, at), Number(s.slice(at + 1))];
  });
  const clock = num(last.revealMs), waited = num(last.revealWaited);
  const motionMs = motion ? motion.reduce((n, [, ms]) => n + ms, 0) : null;
  const endAt = frames.findIndex(f => f.t >= sent && f.revealMs != null);
  const seen = frames.slice(0, endAt < 0 ? frames.length : endAt + 1).filter(f => f.t > sent);
  const gaps = seen.map((f, i) => ({ ms: f.t - (i ? seen[i - 1].t : sent), dots: f.sphere }));
  const slowest = Math.max(0, ...gaps.map(g => g.ms));
  const drawing = gaps.filter(g => g.dots).map(g => g.ms).sort((a, b) => a - b);
  const bulk = drawing.length ? drawing : gaps.map(g => g.ms).sort((a, b) => a - b);
  return {
    reveal_ms: clock,
    motion,
    motion_ms: motionMs,
    waited_ms: waited,
    late_ms: clock == null || motionMs == null ? null : clock - motionMs - (waited || 0),
    slowest_frame_ms: Math.round(slowest),
    pace_frame_ms: Math.round(bulk.length ? bulk[Math.floor(0.75 * (bulk.length - 1))] : 0),
  };
}

// One stretch, from the owner's first act (a tap that opens a field, or the
// tap that answers) to the next card at rest. marks: the page times of the
// acts in this stretch; the last one sends. before: the frame before them.
function summarize(frames, marks, before) {
  const opened = marks[0].t, sent = marks[marks.length - 1].t;
  const typing = frames.filter(f => f.t >= opened && f.t < sent);
  const after = frames.filter(f => f.t >= sent);
  const leftAt = after.findIndex(f => f.leaving || !f.hasCard);
  const holding = leftAt < 0 ? after : after.slice(0, leftAt);
  const gone = leftAt < 0 ? [] : after.slice(leftAt);
  // the next card: the first frame where a different card is up again, and every frame after it
  const backAt = gone.findIndex(f => f.hasCard && !f.leaving && f.card !== before.card);
  const landed = backAt < 0 ? [] : gone.slice(backAt).filter(f => f.boxOpacity > 0.05);
  const spot0 = holding[0] && holding[0].spot;
  // the rest of the card, row by row against where it sat before the first act
  const othersMoved = f => most(f.rows.map((row, i) => (row.spot ? 0 : dist(row.r, before.rows[i] && before.rows[i].r))));
  const othersOpacity = f => (f ? most(f.rows.filter(row => !row.spot).map(row => row.o)) : null);
  let step = 0;
  for (let i = 1; i < holding.length; i++) step = Math.max(step, dist(holding[i].spot, holding[i - 1].spot));
  for (let i = 1; i < landed.length; i++) step = Math.max(step, dist(landed[i].title, landed[i - 1].title));
  const last = frames[frames.length - 1];
  return {
    others_dimmed_to: round(othersOpacity(typing[typing.length - 1] || holding[holding.length - 1])),
    others_moved_px: round(most([...typing, ...holding].map(othersMoved))),
    hold_ms: leftAt < 0 ? null : Math.round(after[leftAt].t - sent),
    held_as_chosen: holding.length > 0 && holding.every(f => f.spotChosen),
    held_moved_px: round(most(holding.map(f => dist(f.spot, spot0)))),
    // the card went into the sphere and came back out of it
    through_sphere: gone.some(f => f.sphere && !f.hasCard),
    title_max_px: landed.length ? round(most(landed.map(f => dist(f.title, before.title)))) : null,
    title_rest_px: round(dist(last.title, before.title)),
    largest_frame_step_px: round(step),
    next_title: last.titleText,
    ...reveal(frames, sent),
  };
}

// ---- running the page ------------------------------------------------------------------

const SETTLED = "!document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card') && !document.getElementById('bet').hidden && document.getElementById('bet').classList.contains('up') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning') && !document.getElementById('bet').classList.contains('holding')";
// the card on screen reads this title, at rest
const titled = t => `${SETTLED} && document.querySelector('#bet h1') && document.querySelector('#bet h1').textContent === ${JSON.stringify(t)}`;

// The real page on a phone-size headless Chrome (or the viewport given),
// served with this desk and at rest on its first card. fn(p, send) drives
// it; Chrome and the server are closed after, whatever happens.
// reduced: the phone asks for reduced motion; page: another build of the page
async function onPhone(desk, chromePath, fn, viewport = PHONE, { firstCard = true, reduced = false, page = phonePage } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const server = await serve(desk, page);
  let chrome = null;
  try {
    chrome = await launch(chromePath);
    const { send } = chrome;
    await send('Emulation.setDeviceMetricsOverride', viewport);
    if (reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.enable');
    await send('Page.navigate', { url: server.url });
    const p = driver(send);
    if (firstCard) await p.until(`document.readyState === 'complete' && ${SETTLED} && Boolean(document.querySelector('#bet h1'))`, 'the first card');
    else await p.until("document.readyState === 'complete'", 'the page');
    return await fn(p, send);
  } finally {
    if (chrome) chrome.close();
    await server.close();
  }
}

// a tap on the button that reads label, wherever it sits on the card
async function tapLabel(p, send, label) {
  const r = await p.run(`(function () { var n = Array.prototype.find.call(document.querySelectorAll('#bet button, .foot button'), function (b) { return b.textContent === ${JSON.stringify(label)} && b.offsetParent; }); if (!n) return null; n.scrollIntoView({ block: 'center', inline: 'center' }); var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`no button reads ${label}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
}

async function key(send, name, code) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
}
const esc = send => key(send, 'Escape', 27);

// what the card on screen shows: its kind and title, every button by the
// option it is, whether it has a box, and what is being typed
const LOOK = `(function () {
  var box = document.getElementById('bet');
  var h = box.querySelector('h1');
  var input = box.querySelector('.field input');
  var note = box.querySelector('.act .note');
  return {
    has_card: document.body.classList.contains('has-card') && !box.hidden,
    kind: box.getAttribute('data-kind'),
    card: box.getAttribute('data-card'),
    title: h ? h.textContent : null,
    options: Array.prototype.map.call(box.querySelectorAll('[data-option]'), function (b) { return b.getAttribute('data-option'); }),
    buttons: Array.prototype.map.call(box.querySelectorAll('button'), function (b) { return b.textContent; }),
    box_line: Boolean(box.querySelector('.sayline')),
    field_open: Boolean(box.querySelector('.field')),
    words: input ? input.value : null,
    typing: Boolean(input && document.activeElement === input),
    line: note && note.textContent ? note.textContent : null,
    said: box.querySelector('.mission') ? box.querySelector('.mission').textContent : null,
    under_orb: document.getElementById('line').textContent,
  };
})()`;
const look = p => p.run(LOOK);

// the cursor sits in the typing spot itself, not in a box somewhere else
const CURSOR = "Boolean(document.querySelector('#bet .field') && document.querySelector('#bet .field').contains(document.activeElement) && document.activeElement.tagName === 'INPUT')";

// ---- the main trace: typing in place, then one motion to the next card -------------------

async function trace({ chromePath = findChrome(), shots = null } = {}) {
  const desk = scriptedDesk();
  return onPhone(desk, chromePath, async (p, send) => {
    const shot = async (name) => {
      if (!shots) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };
    await p.run(RECORDER);
    const frames = () => p.run('window.__trace.frames');
    const lastFrame = async () => { const f = await frames(); return f[f.length - 1]; };
    const results = [];
    // a stretch that never finishes stops the run; what came before is kept
    let failed = null;
    const stretch = async (name, act, done) => {
      if (failed) return { name, skipped: true };
      try {
        await wait(80);
        const before = await lastFrame();
        const seen = (await p.run('window.__trace.marks')).length;
        const out = { name };
        await act(out);
        const marks = (await p.run('window.__trace.marks')).slice(seen);
        await p.until(done, `${name} to finish`, 8000);
        await wait(150);
        return { ...out, ...summarize(await frames(), marks, before) };
      } catch (err) {
        failed = `${name}: ${err.message}`;
        return { name, error: err.message };
      }
    };
    const fresh = () => p.run("document.body.removeAttribute('data-reveal-ms')");

    // one: something else becomes the field in its spot, Enter holds it, then the next card
    results.push(await stretch('typed in place of something else', async (out) => {
      const button = await p.rect('#bet .choice.other');
      await p.tap('#bet .choice.other');
      await wait(250);
      const field = await p.rect('#bet .field');
      out.field_vs_button_px = { moved: round(dist(field, button)), resized: round(size(field, button)) };
      out.cursor_in_field = await p.run(CURSOR);
      await p.type('paying schools');
      await shot('1-typing');
      await p.enter();
      await wait(100);
      await shot('2-held');
    }, `${titled(CARDS.b1.title)} && document.body.hasAttribute('data-reveal-ms')`));

    // two: or say something becomes the field in its own spot; a question
    // back gets a reply in the title's spot, with the card's own options once
    await fresh();
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
      await wait(100);
      await shot('4-say-held');
    }, `${titled(REPLY)} && document.body.hasAttribute('data-reveal-ms')`));
    await shot('5-reply');
    if (!failed) results[1].reply = await look(p);

    // three: a tapped answer the reply added holds as chosen, then the next card
    await fresh();
    results.push(await stretch('tapped an answer on the reply', async () => {
      await tapLabel(p, send, 'sounds good');
      await wait(100);
      await shot('6-answer-held');
    }, `${titled(CARDS.c1.title)} && document.body.hasAttribute('data-reveal-ms')`));

    // four: a tapped idea in a choice holds, then its own card
    await fresh();
    results.push(await stretch('tapped an idea', async () => {
      await p.tap('#bet .option');
      await wait(100);
      await shot('7-idea-held');
    }, `${titled(CARDS.b2.title)} && document.body.hasAttribute('data-reveal-ms')`));

    await shot('8-next');
    await p.run('window.__trace.on = false');
    return { viewport: `${PHONE.width}x${PHONE.height}`, frames: (await frames()).length, failed, stretches: results };
  });
}

// ---- Esc: the typing first, then one card back per press ---------------------------------

const TEAM_ROWS = [{ member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'stopped', sentence: 'stopped: the getting started page, stopped 2 hours ago' }];
const teamCard = (rows, n = 1, line = null) => gmCard.team({ id: `team~${n}`, rows, line, deck: false });
const memberCard = (name, n = 1, line = null) => gmCard.member({ id: `member~${n}`, name, sentence: 'stopped: the getting started page, stopped 2 hours ago.', line });

// From the first card the owner opens the team, a member's talk card from
// its row, starts typing and presses Esc (the words go), types again and
// sends, which asks for a second tap to start them, then presses Esc until
// the first card is back, and once more. Each step reads the card.
async function escapeTrace({ chromePath = findChrome() } = {}) {
  let n = 1;
  const desk = cardDesk(CARDS.q1, async (action, { card, option, text }) => {
    n += 1;
    if (action === 'open:team') return { card: teamCard(TEAM_ROWS, n) };
    if (action === 'member') return { card: memberCard(option.binds.member, n) };
    if (action === 'talk') return { card: gmCard.reply({ id: `${card.id}~r${n}`, base: card, text: 'tap again to start builder on this', confirm: { text } }) };
    if (action === 'back') {
      if (card.kind === 'reply') return { card: memberCard('builder', n) };
      if (card.kind === 'member') return { card: teamCard(TEAM_ROWS, n) };
      return { card: CARDS.q1 };
    }
    return { card };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    const steps = [];
    const at = async (did) => { await wait(150); steps.push({ did, ...(await look(p)) }); };
    const rest = () => p.until(SETTLED, 'the card at rest', 6000);
    await at('the card');
    await esc(send);
    await at('esc on the card');
    await p.tap('#working');
    await p.until(titled('the team'), 'the team card');
    await at('opened the team');
    await p.tap('#bet tbody td.member button');
    await p.until(titled('builder'), 'the talk card');
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    await p.type('take the readme first');
    await at('typing to builder');
    await esc(send);
    await at('esc while typing');
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    await p.type('take the readme first');
    await p.enter();
    await p.until(titled('tap again to start builder on this'), 'the second tap it asks for');
    await at('sent to builder');
    for (let i = 1; i <= 4; i++) { await esc(send); await wait(200); await rest().catch(() => {}); await at(`esc ${i}`); }
    return { viewport: `${PHONE.width}x${PHONE.height}`, steps };
  });
}

// ---- an answer goes to the card on screen, or nowhere --------------------------------------

// two questions whose answers share ids, as written questions do: a2 is
// "small teams" on the first and "fewer mistakes" on the second
const STALE = {
  q1: gmCard.question({ id: 'question:q1', title: 'who uses the phone page most?', body: 'the phone page went live this week.', choices: [{ id: 'a1', label: 'solo founders' }, { id: 'a2', label: 'small teams' }] }),
  q2: gmCard.question({ id: 'question:q2', title: 'what would make a small team pay?', body: 'installs dropped to 1,511 last week.', choices: [{ id: 'a1', label: 'saving them hours' }, { id: 'a2', label: 'fewer mistakes' }] }),
};

// The owner answers the first question. The desk saves it and moves to the
// second, but the answer back to the page is lost. The owner taps the same
// answer on the old card, still on screen. The desk refuses an act that
// names another card than its own, and the page shows the card it has.
async function staleAnswerTrace({ chromePath = findChrome() } = {}) {
  const saved = [];
  const posts = [];
  let lose = true;
  const desk = cardDesk(STALE.q1, async (action, { card, option }) => {
    if (action !== 'answer') return { card };
    saved.push({ question: card.title, answer: option.label });
    desk.current = STALE.q2;
    if (lose) { lose = false; throw new Error('the answer was lost'); }
    return { card: null };
  });
  const act = desk.act;
  desk.act = (body) => { posts.push({ card: body.card_id, option: body.option_id }); return act(body); };
  return onPhone(desk, chromePath, async (p, send) => {
    await tapLabel(p, send, 'small teams');
    await p.until(`${titled(STALE.q1.title)} && Boolean(document.querySelector('#bet .act .note').textContent)`, 'the lost answer', 8000);
    const after_lost = await look(p);
    await tapLabel(p, send, 'small teams');
    await p.until(titled(STALE.q2.title), 'the card the desk has', 8000);
    return { after_lost, at_end: await look(p), posts, saved };
  });
}

// ---- words that did not send stay in the box ----------------------------------------------

// The owner types in "or say something". The first send never leaves the
// phone (the network is off), the second reaches a desk that could not pass
// it on, the third goes through. After each failure: is the box still
// there, with the words and the cursor in it, and what does the line say.
async function unsentSayTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'please use the short introduction I wrote';
  const calls = [];
  const desk = cardDesk(CARDS.b1, async (action, { text }) => {
    calls.push({ action, text });
    if (calls.length === 1) return { ok: false, reason: 'steer_failed', message: 'it did not reach them. try again in a minute.' };
    return { card: CARDS.b2 };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    const back = () => p.until(`${titled(CARDS.b1.title)} && Boolean(document.querySelector('#bet .field'))`, 'the card back with the words', 8000);
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(WORDS);
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p.enter();
    await back();
    await wait(150);
    const offline = await look(p);
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p.enter();
    await wait(400);
    await back();
    await wait(150);
    const refused = await look(p);
    await p.enter();
    await p.until(titled(CARDS.b2.title), 'the next card', 8000).catch(() => {});
    const sent = await look(p);
    return { words: WORDS, offline, refused, sent, calls };
  });
}

// ---- a word to a teammate that did not send comes back, ready to send again -------------

// On builder's talk card the owner writes to builder. The first send never
// leaves the phone (the network is off). The second reaches the desk, but
// the answer back is lost. The third goes again with the same words, so it
// carries the same send id and builder hears it once.
async function talkFailTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'take the readme first';
  const took = [];
  let n = 1;
  const desk = cardDesk(memberCard('builder', 1), async (action, { text }) => {
    if (action !== 'talk') return { ok: false, reason: 'bad_option', message: 'that does nothing here' };
    took.push(text);
    n += 1;
    return { card: memberCard('builder', n, 'builder has it.') };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    const net = offline => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    // the page's own fetch: every word to builder is kept, and the answer to the second one never arrives
    await p.run("(function () { var real = window.fetch; window.__talks = []; window.fetch = function (url, opts) { var go = real(url, opts); if (String(url).indexOf('/act') < 0 || !opts || !opts.body || JSON.parse(opts.body).text === undefined) return go; window.__talks.push(JSON.parse(opts.body)); if (window.__talks.length !== 2) return go; return go.then(function () { throw new TypeError('Failed to fetch'); }); }; })()");
    const back = () => p.until(`${titled('builder')} && Boolean(document.querySelector('#bet .field'))`, 'the talk card back with the words', 8000);
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(WORDS);
    await send('Network.enable');
    await net(true);
    await p.enter();
    await back();
    await wait(150);
    const offline = await look(p);
    await net(false);
    await p.enter();
    await wait(400);
    await back();
    await wait(150);
    const lost = await look(p);
    await p.enter();
    await p.until(`${titled('builder')} && Boolean(document.querySelector('#bet .mission'))`, 'builder has it', 8000).catch(() => {});
    const sent = await look(p);
    return { words: WORDS, offline, lost, sent, posts: await p.run('window.__talks'), took };
  });
}

// ---- a reply that explains keeps the card's own answer --------------------------------------

// On an idea (do it) and on a yes card (yes), the owner asks what it means.
// The reply explains, so the card's own button is there once and still
// works: two taps, and the desk is asked to do it or hears the yes.
async function replyKeepsActionTrace({ chromePath = findChrome() } = {}) {
  const runs = [];
  for (const [base, label, armed] of [[CARDS.b1, 'do it', 'tap again to start'], [CARDS.yes, 'yes', 'tap again to say yes']]) {
    const did = [];
    const desk = cardDesk(base, async (action, { card }) => {
      if (action === 'say') return { card: replyTo(card) };
      did.push(action);
      return { card: CARDS.b2, ack: 'sent.' };
    });
    runs.push(await onPhone(desk, chromePath, async (p, send) => {
      await p.tap('#bet .sayline .quiet');
      await wait(250);
      await p.type('what do you mean?');
      await p.enter();
      await p.until(titled(REPLY), 'the reply', 8000);
      await wait(150);
      const after_reply = await look(p);
      let error = null;
      try {
        await tapLabel(p, send, label);
        await p.until(`Array.prototype.some.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent === ${JSON.stringify(armed)}; })`, 'the armed tap', 2000);
        await tapLabel(p, send, armed);
        const end = Date.now() + 3000;
        while (!did.length && Date.now() < end) await wait(16);
      } catch (err) { error = err.message; }
      return { card: base.id, label, after_reply, did, error };
    }));
  }
  return runs;
}

// ---- the small orb on any card goes back to the big one -----------------------------------

// On an idea and on a yes card the owner taps the small orb at the top; on
// the calm line, while the next idea is written, the sphere itself is the
// orb on the card and they tap its dots. Where the page ends up and whether
// it asked for a new card; then a tap on the big orb. On the calm line the
// idea lands while the owner is on the big orb, and waits there.
async function orbHomeTrace({ chromePath = findChrome() } = {}) {
  const runs = [];
  for (const from of ['idea', 'calm', 'yes']) {
    let asked = 0;
    let landed = false;
    const first = from === 'idea' ? CARDS.b1 : from === 'yes' ? CARDS.yes : CARDS.calm;
    const desk = cardDesk(first, async (action, { card }) => {
      if (action === 'orb') { asked += 1; return { card: card === CARDS.calm && landed ? CARDS.b1 : CARDS.b2 }; }
      return { card };
    }, { queue: () => (landed ? 1 : 0), needs: () => (from === 'yes' ? 2 : 0) });
    runs.push(await onPhone(desk, chromePath, async (p) => {
      const place = () => p.run("(function () { var h = document.querySelector('#bet h1'); return { has_card: document.body.classList.contains('has-card'), big_orb: getComputedStyle(document.querySelector('.stage')).display !== 'none' && getComputedStyle(document.getElementById('orb')).visibility !== 'hidden', line: document.getElementById('line').textContent, title: document.body.classList.contains('has-card') && h ? h.textContent : null }; })()");
      await p.tap(from === 'calm' ? '#orb' : '#lava');
      await p.until("!document.body.classList.contains('has-card')", 'the big orb', 4000).catch(() => {});
      await wait(900);
      const home = { ...(await place()), asked };
      if (from === 'calm') { landed = true; await wait(3500); }
      const stayed = { ...(await place()), asked };
      await p.tap('#orb');
      await p.until(SETTLED, 'a card', 8000).catch(() => {});
      await wait(300);
      const tapped = { ...(await place()), asked };
      return { from, home, stayed, tapped };
    }));
  }
  return runs;
}

// ---- a start that did not get going comes back to do it --------------------------------------

// The owner asks what an idea means, then taps do it twice. The first start
// does not get going; the second does. After the failed one: the card it
// comes back on, its buttons, and the line under them.
async function startFailTrace({ chromePath = findChrome() } = {}) {
  const starts = [];
  const desk = cardDesk(CARDS.b1, async (action, { card }) => {
    if (action === 'say') return { card: replyTo(card) };
    if (action !== 'do') return { card };
    starts.push(starts.length + 1);
    if (starts.length === 1) return { ok: false, reason: 'start_failed', message: 'it did not get going. try again in a minute.' };
    return { card: CARDS.b2, ack: 'builder has it and is starting now.' };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type('what do you mean?');
    await p.enter();
    await p.until(titled(REPLY), 'the reply', 8000);
    await wait(150);
    await tapLabel(p, send, 'do it');
    await wait(100);
    await tapLabel(p, send, 'tap again to start');
    await p.until(`${titled(REPLY)} && Boolean(document.querySelector('#bet .act .note').textContent)`, 'the card back with why', 8000);
    const failed = await look(p);
    let error = null;
    let under = null;
    try {
      await tapLabel(p, send, 'do it');
      await wait(100);
      await tapLabel(p, send, 'tap again to start');
      // who has it shows under the sphere before the next card
      await p.until("document.getElementById('line').textContent === 'builder has it and is starting now.'", 'who has it', 4000);
      under = await p.run("document.getElementById('line').textContent");
      await p.until(titled(CARDS.b2.title), 'the next card', 8000);
    } catch (err) { error = err.message; }
    return { failed, starts: starts.length, under, error };
  });
}

// ---- a send that went through is never sent twice -------------------------------------------

// The owner says something on an idea. It reaches the desk, but the answer
// back to the phone is lost, so the words come back in the box. The owner
// hits Enter again. Then, on the next card, the owner says something new.
// Every post the page made and every word the desk took are kept.
async function lostReplyTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'add the short demo too';
  const NEW = 'and send it to the twelve schools';
  const took = [];
  const desk = cardDesk(CARDS.b1, async (action, { card, text }) => {
    took.push(text);
    return { card: card.id === CARDS.b1.id ? CARDS.b2 : CARDS.b1 };
  });
  return onPhone(desk, chromePath, async (p) => {
    // the page's own fetch: every word said is kept, and the first one's answer never arrives
    await p.run("(function () { var real = window.fetch; window.__says = []; window.fetch = function (url, opts) { var go = real(url, opts); if (String(url).indexOf('/act') < 0 || !opts || !opts.body || JSON.parse(opts.body).text === undefined) return go; window.__says.push(JSON.parse(opts.body)); if (window.__says.length > 1) return go; return go.then(function () { throw new TypeError('Failed to fetch'); }); }; })()");
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(WORDS);
    await p.enter();
    await p.until(`${titled(CARDS.b1.title)} && Boolean(document.querySelector('#bet .field'))`, 'the words back in the box', 8000);
    const kept = await p.run("(function () { var i = document.querySelector('#bet .field input'); return i ? i.value : null; })()");
    await p.enter();
    await p.until(titled(CARDS.b2.title), 'the next card', 8000).catch(() => {});
    await p.tap('#bet .sayline .quiet');
    await wait(250);
    await p.type(NEW);
    await p.enter();
    await p.until(titled(CARDS.b1.title), 'the card after', 8000).catch(() => {});
    return { words: WORDS, new_words: NEW, kept, posts: await p.run('window.__says'), took };
  });
}

// ---- the team card at phone and laptop width --------------------------------------------------

// a real-sized team: long roles and statuses, a rookie, and no rating or model
const TABLE_ROWS = [
  { member: 'navigator', role: 'system navigator', ovr: '84', engine: 'tool one m-small', status: 'waiting for your yes', sentence: 'waiting for your yes: plan the pricing page, asked 2 hours ago' },
  { member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: launch a try page for any public repo, about 4 hours left' },
  { member: 'auto-improver', role: 'continuous improver', ovr: 'new', engine: 'tool one m-one', status: 'stopped', sentence: 'stopped: split the big test file so each part runs alone, stopped 30 minutes ago' },
  { member: 'linguist', role: 'linguist, operator language and understanding', ovr: '··', engine: '··', status: 'idle', sentence: 'idle: no work in the last day' },
  { member: 'validator', role: 'reviewer', ovr: '89', engine: 'tool two m-two', status: 'idle', sentence: 'idle: no work in the last day' },
];

// every body cell as the page holds it: the words shown, the markup behind
// them, and how many elements it holds besides a tap target
const TABLE_CELLS = `[].map.call(document.querySelectorAll('#bet tbody tr'), function (tr) {
  return [].map.call(tr.cells, function (td) {
    return { text: td.textContent, html: td.innerHTML, elements: td.querySelectorAll(':not(button):not(span)').length };
  });
})`;

// what the table looks like on screen: the column names, whether any cell's
// words spill out of it, every inner line, the side scroll, where the name
// column sits once scrolled, and whether anything on it moves
const TABLE_LOOK = `(function () {
  var box = document.getElementById('bet');
  var grid = box.querySelector('.grid');
  var table = box.querySelector('table');
  if (!grid || !table) return null;
  // each column by its key (the class on its header), and the words the owner reads over it
  var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (n) { return n.className; });
  var words = Array.prototype.map.call(table.querySelectorAll('thead th'), function (n) { return n.textContent; });
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  var spills = [], lines = { inner_right: 0, missing_right: 0, inner_bottom: 0, missing_bottom: 0 }, oneLine = [], moving = [];
  var widths = {};
  rows.forEach(function (tr, ri) {
    Array.prototype.forEach.call(tr.children, function (td, ci) {
      var cs = getComputedStyle(td);
      if (td.scrollWidth > td.clientWidth + 1) spills.push(heads[ci] + ' of ' + tr.querySelector('td.member').textContent);
      if (ci < tr.children.length - 1) { if (cs.borderRightWidth === '1px') lines.inner_right += 1; else lines.missing_right += 1; }
      if (ri < rows.length - 1) { if (cs.borderBottomWidth === '1px') lines.inner_bottom += 1; else lines.missing_bottom += 1; }
      var w = td.getBoundingClientRect().width;
      widths[heads[ci]] = Math.min(widths[heads[ci]] == null ? Infinity : widths[heads[ci]], Math.round(w));
      if (['member', 'ovr', 'engine'].indexOf(heads[ci]) >= 0) {
        var text = td.querySelector('button') || td;
        var r = document.createRange(); r.selectNodeContents(text);
        if (r.getClientRects().length > 1) oneLine.push(heads[ci] + ' of ' + tr.querySelector('td.member').textContent);
      }
      if (cs.animationName !== 'none' || parseFloat(cs.transitionDuration) > 0 || cs.boxShadow !== 'none') moving.push(heads[ci]);
    });
  });
  var g = grid.getBoundingClientRect();
  var before = table.querySelector('tbody td.member').getBoundingClientRect().left;
  grid.scrollLeft = 200;
  var scrolled = grid.scrollLeft;
  var after = table.querySelector('tbody td.member').getBoundingClientRect().left;
  grid.scrollLeft = 0;
  var sizes = Array.prototype.map.call(table.querySelectorAll('th, td, td button'), function (n) { return parseFloat(getComputedStyle(n).fontSize); });
  return {
    heads: heads,
    head_words: words,
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
    statuses: Array.prototype.map.call(table.querySelectorAll('tbody td.status'), function (n) { return n.textContent; }),
  };
})()`;

// Opens the team card at one viewport, reads TABLE_LOOK, then taps a
// member's role cell (the part of a row that is always on screen), reads
// the talk card, and presses Esc twice: back to the team, then the first card.
async function teamTableTrace({ chromePath = findChrome(), viewport = PHONE, shots = null, rows = TABLE_ROWS } = {}) {
  let n = 1;
  const desk = cardDesk(CARDS.b1, async (action, { card, option }) => {
    n += 1;
    if (action === 'open:team') return { card: teamCard(rows, n) };
    if (action === 'member') return { card: memberCard(option.binds.member, n) };
    if (action === 'back') return { card: card.kind === 'member' ? teamCard(rows, n) : CARDS.b1 };
    return { card };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    const where = () => p.run("({ kind: document.getElementById('bet').getAttribute('data-kind'), title: document.querySelector('#bet h1').textContent, table: Boolean(document.querySelector('#bet table')) })");
    await p.tap('#working');
    await p.until(`${titled('the team')} && Boolean(document.querySelector('#bet tbody tr'))`, 'the team card', 8000);
    await wait(100);
    const tableLook = await p.run(TABLE_LOOK);
    const cells = await p.run(TABLE_CELLS);
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(shots, `team-${viewport.width}x${viewport.height}.png`), Buffer.from(shot.data, 'base64'));
    }
    await p.tap('#bet tbody tr:nth-child(2) td.role');
    await p.until(titled('builder'), 'the talk card', 8000);
    const talk = await where();
    await esc(send);
    await p.until(titled('the team'), 'the team again', 8000);
    const back = await where();
    await esc(send);
    await p.until(titled(CARDS.b1.title), 'the first card again', 8000);
    const closed = await where();
    return { viewport: `${viewport.width}x${viewport.height}`, look: tableLook, cells, talk, back, closed };
  }, viewport);
}

// ---- the swap card ---------------------------------------------------------------------------------

// the swap list as the roster gives it: the Atris model, the owner's pick, then more models
const SWAP = {
  member: 'builder',
  job: 'build',
  line: 'builder runs on tool one m-one.',
  scopes: [{ id: 'member', label: 'just builder' }, { id: 'job', label: 'for every build job' }],
  options: [
    { engine: 'atris', tool: 'atris', model: 'fast', label: 'atris fast', atris: true, current: false, record: null },
    { engine: 'one', tool: 'tool one', model: 'm-one', label: 'm-one', pick: true, current: true, record: '3 of 4 landed' },
    { more: true, label: 'more models', options: [
      { engine: 'atris', tool: 'atris', model: 'fast', label: 'atris fast', current: false, record: null },
      { engine: 'one', tool: 'tool one', model: 'm-one', label: 'm-one', current: true, record: '3 of 4 landed' },
      { engine: 'two', tool: 'tool two', model: 'm-two', label: 'm-two', current: false, record: '2 of 2 landed' },
    ] },
  ],
};

// From the team card, a tap on builder's engine opens the swap card: the
// short list, then more models on the same card, who the swap is for, and
// one tap on a model, which brings the team back with one line.
async function engineCardTrace({ chromePath = findChrome(), viewport = PHONE, shots = null } = {}) {
  const rows = TABLE_ROWS.map(r => ({ ...r }));
  const swaps = [];
  let n = 1;
  let scope = 'member';
  let all = false;
  const swapCard = () => gmCard.swap({ id: `swap~${n}`, name: 'builder', choices: SWAP, scope, all });
  const desk = cardDesk(CARDS.b1, async (action, { card, option }) => {
    if (action === 'open:team') { n += 1; return { card: teamCard(rows, n) }; }
    if (action === 'swap') { n += 1; scope = 'member'; all = false; return { card: swapCard() }; }
    if (action === 'more') { n += 1; all = true; return { card: swapCard() }; }
    if (action === 'scope') { n += 1; scope = option.binds.scope; return { card: swapCard() }; }
    if (action === 'swap_to') {
      swaps.push({ member: 'builder', ...option.binds });
      rows.find(r => r.member === 'builder').engine = `${option.binds.engine} ${option.binds.model}`;
      n += 1;
      return { card: teamCard(rows, n, `builder now runs on ${option.binds.engine} ${option.binds.model}.`), ack: 'swapped.' };
    }
    if (action === 'back') { n += 1; return { card: card.kind === 'swap' ? teamCard(rows, n) : CARDS.b1 }; }
    return { card };
  });
  return onPhone(desk, chromePath, async (p, send) => {
    const cell = '#bet tbody tr:nth-child(2) td.engine button';
    await p.tap('#working');
    await p.until(`${titled('the team')} && Boolean(document.querySelector('#bet tbody tr'))`, 'the team card', 8000);
    // at phone width the engine column sits past the edge; scroll it in like a thumb would
    await p.run(`document.querySelector(${JSON.stringify(cell)}).scrollIntoView({ block: 'center', inline: 'center' })`);
    await wait(60);
    await p.tap(cell);
    await p.until(`${titled('builder')} && document.getElementById('bet').getAttribute('data-kind') === 'swap'`, 'the swap card', 8000);
    const short = await look(p);
    const id = short.card;
    await tapLabel(p, send, 'more models');
    await p.until(`${SETTLED} && Array.prototype.some.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent.indexOf('m-two') === 0; })`, 'the full list', 8000);
    const full = await look(p);
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(shots, `swap-card-${viewport.width}x${viewport.height}.png`), Buffer.from(shot.data, 'base64'));
    }
    await tapLabel(p, send, 'everyone doing builder\'s kind of work');
    await p.until(`${SETTLED} && Boolean(document.querySelector('#bet [data-option="scope:job"].chosen'))`, 'who the swap is for', 8000);
    const scoped = await look(p);
    await p.run("(function () { var b = Array.prototype.find.call(document.querySelectorAll('#bet button.choice'), function (n) { var t = n.querySelector('.t'); return t && t.textContent === 'm-two'; }); b.scrollIntoView({ block: 'center' }); })()");
    const two = await p.run("(function () { var b = Array.prototype.find.call(document.querySelectorAll('#bet button.choice'), function (n) { var t = n.querySelector('.t'); return t && t.textContent === 'm-two'; }); return b.getAttribute('data-option'); })()");
    await p.tap(`#bet [data-option="${two}"]`);
    await p.until(`${titled('the team')} && Boolean(document.querySelector('#bet .mission'))`, 'the team after the swap', 8000);
    const after = await look(p);
    const engine = await p.run("document.querySelector('#bet tbody tr:nth-child(2) td.engine').textContent");
    return { viewport: `${viewport.width}x${viewport.height}`, short, id, full, scoped, after, engine, swaps };
  }, viewport);
}

// ---- the job deck -------------------------------------------------------------------------------

// the deck card is about the job: the rating and the model live on the team table
const DECK_COLUMNS = ['work', 'member', 'role', 'status'];
const DECK_JOBS = [
  { job_id: 'm-nav', mission_id: 'm-nav', member: 'navigator', label: 'needs you', time: 'asked 2 hours ago', rows: [{ done: 'not yet', work: 'plan the pricing page', member: 'navigator', role: 'system navigator', ovr: '84', engine: 'tool one m-small', status: 'needs you' }], yes: { key: 'm-nav:step-2:abc', hash: 'abc', what: 'navigator wants to publish the pricing page', why: 'navigator is waiting on your yes for this.' } },
  { job_id: 'm-b1', mission_id: 'm-b1', member: 'builder', label: 'needs you', time: 'asked 20 minutes ago', rows: [{ done: 'not yet', work: 'launch a try page for any public repo', member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'needs you' }], yes: { key: 'm-b1:0', what: 'ok to post the try page on x?', why: 'builder is waiting on your yes for this.' } },
  { job_id: 'm-b2', mission_id: 'm-b2', member: 'builder', label: 'working', time: 'about 4 hours left', rows: [{ done: 'not yet', work: 'split the big test file', member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working' }] },
];

// The owner opens the job deck from the need-you line. The arrows flip it
// one card at a time in its spot, a sideways swipe flips it, a swipe that
// is mostly down does not, and the arrows move the cursor while typing.
// One tap arms only the card's own yes: a flip draws a fresh card. The yes
// sends what its card binds. Esc goes back to the whole team.
async function deckTrace({ chromePath = findChrome(), shots = null } = {}) {
  const yesSent = [];
  let at = 0;
  let n = 1;
  const said = {};
  const deckCard = () => {
    n += 1;
    const c = { ...DECK_JOBS[at], said: said[DECK_JOBS[at].job_id] || null };
    if (c.said) { c.yes = null; c.label = 'you answered'; }
    const r = c.rows[0];
    return gmCard.deck({ id: `deck~${n}`, at, total: DECK_JOBS.length, card: c, columns: DECK_COLUMNS, job: { member: c.member, role: r.role, ovr: r.ovr, engine: r.engine } });
  };
  const desk = cardDesk(CARDS.b1, async (action, { option }) => {
    if (action === 'open:deck') { at = 0; return { card: deckCard() }; }
    if (action === 'flip') { at = (at + option.binds.step + DECK_JOBS.length) % DECK_JOBS.length; return { card: deckCard() }; }
    if (action === 'yes') { yesSent.push(option.binds); said[DECK_JOBS[at].job_id] = `${DECK_JOBS[at].member}: got your yes`; return { card: deckCard() }; }
    if (action === 'back') { n += 1; return { card: teamCard(TABLE_ROWS, n) }; }
    if (action === 'talk') return { card: deckCard() };
    return { card: deckCard() };
  }, { needs: () => 2 });
  return onPhone(desk, chromePath, async (p, send) => {
    const ARROW = { ArrowLeft: 37, ArrowRight: 39 };
    const press = k => key(send, k, ARROW[k]);
    const settle = async () => { await wait(80); await p.until(SETTLED, 'the card at rest', 6000); };
    const count = () => p.run("(function () { var c = document.querySelector('#bet .count'); return c ? c.textContent : null; })()");
    const spot = () => p.run("(function () { var b = document.getElementById('bet').getBoundingClientRect(); return { x: b.left, y: b.top }; })()");
    const swipe = async (x0, y0, x1, y1) => {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= 6; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 6, y: y0 + ((y1 - y0) * i) / 6 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    // a flip is the turn in place when a still copy of the old card shows over the new one
    await p.run("(function () { window.__ghost = false; new MutationObserver(function () { if (document.querySelector('.bet.ghost')) window.__ghost = true; }).observe(document.getElementById('screen'), { childList: true, subtree: true }); })()");
    await tapLabel(p, send, '2 need you');
    await p.until(`${SETTLED} && document.getElementById('bet').getAttribute('data-kind') === 'deck'`, 'the deck', 8000);
    const first = await look(p);
    const firstAt = await spot();
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shots, 'deck-needs-you.png'), Buffer.from(shot.data, 'base64'));
    }
    // one tap on A arms only A: after a flip, B's yes starts fresh, and back on A it does too
    await tapLabel(p, send, 'yes');
    const armedA = await look(p);
    await press('ArrowRight');
    await settle();
    const freshB = await look(p);
    await press('ArrowLeft');
    await settle();
    const freshA = await look(p);
    const counts = [];
    let moved = 0;
    for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft']) {
      await press(k);
      await settle();
      counts.push(await count());
      const s = await spot();
      moved = Math.max(moved, Math.abs(s.x - firstAt.x), Math.abs(s.y - firstAt.y));
    }
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const c = await p.run("(function () { var b = document.querySelector('#bet h1').getBoundingClientRect(); return { x: b.left + 150, y: b.top + b.height / 2 }; })()");
    await swipe(c.x + 100, c.y, c.x - 100, c.y);
    await settle();
    const swiped = await count();
    await swipe(c.x + 40, c.y, c.x - 30, c.y + 200);
    await wait(500);
    await settle();
    const scrolled = await count();
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    // typing: the arrows move the cursor, not the deck
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    await p.type('how far along is it?');
    await press('ArrowRight');
    await wait(500);
    const typingArrow = await count();
    await esc(send);
    await wait(150);
    // back to the first card, then its yes: armed, then sent with what the card binds
    while ((await count()) !== 'job 1 of 3') { await press('ArrowLeft'); await settle(); }
    await tapLabel(p, send, 'yes');
    await tapLabel(p, send, 'tap again to say yes');
    await p.until(`${SETTLED} && Boolean(document.querySelector('#bet .mission'))`, 'the line after the yes', 8000);
    const yesLine = await p.run("document.querySelector('#bet .mission').textContent");
    const moving = await p.run("Array.prototype.filter.call(document.querySelectorAll('#bet *'), function (n) { return getComputedStyle(n).animationName !== 'none'; }).map(function (n) { return n.tagName + '.' + n.className; })");
    await esc(send);
    await p.until(titled('the team'), 'the whole team', 8000).catch(() => {});
    const back = await look(p);
    return {
      first,
      armed_a: armedA.buttons,
      fresh_b: freshB.buttons,
      fresh_a: freshA.buttons,
      counts,
      moved_px: Math.round(moved * 10) / 10,
      ghost_seen: await p.run('window.__ghost'),
      swiped,
      scrolled,
      typing_arrow: typingArrow,
      yes_sent: yesSent,
      yes_line: yesLine,
      moving,
      back,
    };
  });
}

// ---- the same words to two members are two sends --------------------------------------------------

// The owner tells builder "pause this", goes back to the team, and tells
// launcher the same words. Each is its own send, so both reach their member.
async function twoMembersTrace({ chromePath = findChrome() } = {}) {
  const WORDS = 'pause this';
  const rows = [TEAM_ROWS[0], { member: 'launcher', role: 'launcher', ovr: 'new', engine: 'tool two m-two', status: 'working', sentence: 'working: the launch post, about an hour left' }];
  const took = [];
  let n = 1;
  const desk = cardDesk(CARDS.b1, async (action, { card, option, text }) => {
    n += 1;
    if (action === 'open:team') return { card: teamCard(rows, n) };
    if (action === 'member') return { card: memberCard(option.binds.member, n) };
    if (action === 'talk') { took.push({ member: card.member, text }); return { card: memberCard(card.member, n, `sent to ${card.member}.`) }; }
    if (action === 'back') return { card: card.kind === 'member' ? teamCard(rows, n) : CARDS.b1 };
    return { card };
  });
  return onPhone(desk, chromePath, async (p) => {
    const tell = async (member) => {
      await p.until(titled('the team'), 'the team card', 8000);
      await p.tap(`#bet [data-option="talk:${member}"]`);
      await p.until(titled(member), `${member}'s talk card`, 8000);
      await p.tap('#bet .sayline .quiet');
      await wait(200);
      await p.type(WORDS);
      await p.enter();
      await p.until(`${titled(member)} && Boolean(document.querySelector('#bet .mission'))`, `${member} heard it`, 8000).catch(() => {});
      await p.tap('#bet [data-option="back"]');
    };
    await p.tap('#working');
    await tell('builder');
    await tell('launcher');
    return { took };
  });
}

// ---- every kind, one after another ----------------------------------------------------------------

// The page shows each card in the list in turn, every one a card the real
// desk served. After each lands: the options the page drew, by id, against
// the card's own, whether it has its box, and its title. The owner moves on
// with an option that needs no words, or with words in the box.
async function walkTrace({ chromePath = findChrome(), cards } = {}) {
  let at = 0;
  const desk = cardDesk(cards[0], async () => { at = Math.min(at + 1, cards.length - 1); return { card: cards[at] }; });
  return onPhone(desk, chromePath, async (p, send) => {
    const seen = [];
    for (let i = 0; i < cards.length; i++) {
      const card = gmCard.wire(cards[i]);
      await p.until(`${SETTLED} && document.getElementById('bet').getAttribute('data-card') === ${JSON.stringify(card.id)}`, `card ${i + 1}, ${card.kind}`, 8000);
      await wait(100);
      const shown = await look(p);
      seen.push({ kind: card.kind, want: { options: card.options.map(o => o.id), box: Boolean(card.input), title: card.title }, shown: { options: shown.options, box: shown.box_line, title: shown.title } });
      if (i === cards.length - 1) break;
      // an option that moves on without words or a second tap, else the first one, else words in the box
      const plain = card.options.find(o => !o.confirm && !o.type && o.action !== 'none' && !o.cell && ['flip', 'more', 'scope'].indexOf(o.action) < 0);
      const o = plain || card.options.find(x => x.action !== 'none' && !x.cell) || null;
      if (o) {
        await p.run(`document.querySelector('#bet [data-option="${o.id}"]').scrollIntoView({ block: 'center' })`);
        await p.tap(`#bet [data-option="${o.id}"]`);
        if (o.confirm) { await wait(100); await p.tap(`#bet [data-option="${o.id}"]`); }
        if (o.type) { await wait(200); await p.type('a few words'); await p.enter(); }
      } else {
        // the calm line's box is open already; any other box opens on a tap
        await p.tap((await p.run("Boolean(document.querySelector('#bet .sayline .field input'))")) ? '#bet .sayline .field input' : '#bet .sayline .quiet');
        await wait(200);
        await p.type('a few words');
        await p.enter();
      }
    }
    return seen;
  });
}

// ---- the wait: a typed answer, got it, the calm line, a note, the idea out of the dots ------

const CALM_LINES = ['drafting three ideas at once', 'the first draft is in. checking it', 'two drafts are in. picking the stronger one'];
const FOLDED = 'got it, i\'ll fold that in.';

// One row per frame of everything that can move while the owner waits: the
// dots (the orb's own count of frames it drew, how far its dots went, and how
// much of their own clock the frame was), the sphere, the lava, the card and
// its title, the line under the sphere, and the footer. ft is the frame's own
// time, the one the page's animations run on, and the lava's at is the frame
// time its place was set for; t is when this row was read.
const WAIT_RECORDER = `(function () {
  var T = window.__wait = { frames: [], marks: [], on: true };
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') T.marks.push({ what: 'enter', t: performance.now() }); }, true);
  function r(n) { if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
  // a page with no motion count of its own: a sum over a grid of the canvas pixels
  function pixels(canvas) {
    var c = canvas.getContext('2d'), w = canvas.width, h = canvas.height, sum = 0;
    var d = c.getImageData(Math.floor(w * 0.2), Math.floor(h * 0.2), Math.floor(w * 0.6), Math.floor(h * 0.6)).data;
    for (var i = 3; i < d.length; i += 4 * 97) sum += d[i];
    return sum;
  }
  (function rec(now) {
    if (!T.on) return;
    var canvas = document.getElementById('orb'), stage = document.getElementById('stage'), lava = document.getElementById('lava');
    var box = document.getElementById('bet'), foot = document.getElementById('foot'), line = document.getElementById('line');
    var o = canvas.__orb || null;
    var shown = getComputedStyle(stage).display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden';
    var lv = getComputedStyle(lava).visibility !== 'hidden' && Number(getComputedStyle(lava).opacity) > 0.01;
    var field = box.querySelector('.sayline .field');
    T.frames.push({
      t: performance.now(),
      ft: typeof now === 'number' ? now : performance.now(),
      orb: o ? { frame: o.frame, mode: o.mode, step: o.step, mean: o.mean, ms: o.ms } : null,
      pix: o ? null : pixels(canvas),
      sphere: shown && Number(getComputedStyle(stage).opacity) > 0.05,
      stage: shown && Number(getComputedStyle(stage).opacity) > 0.05 ? r(stage) : null,
      lava: lv ? { r: r(lava), o: Number(getComputedStyle(lava).opacity), at: lava.__at } : null,
      box: box.hidden ? null : { o: Number(getComputedStyle(box).opacity), kind: box.getAttribute('data-kind'), card: box.getAttribute('data-card'), title: r(box.querySelector('h1')), titleText: box.querySelector('h1') ? box.querySelector('h1').textContent : '' },
      waiting: document.body.classList.contains('waiting'),
      field: Boolean(field),
      fieldRect: r(field),
      step: (box.querySelector('.waitstep') || {}).textContent || '',
      notes: Array.prototype.map.call(box.querySelectorAll('.waitnotes .turn'), function (n) { return n.textContent; }),
      line: line.textContent,
      lineO: Number(getComputedStyle(line).opacity),
      foot: { r: r(foot), o: Number(getComputedStyle(foot).opacity) },
      busy: document.body.hasAttribute('data-busy'),
    });
    requestAnimationFrame(rec);
  })();
})()`;

const near = (a, b, px = 0.25) => (!a && !b) || (a && b && Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.w - b.w) <= px && Math.abs(a.h - b.h) <= px);
const mid = a => (a ? { x: a.x + a.w / 2, y: a.y + a.h / 2 } : null);
const stepOf = (a, b) => (a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : 0);

// Did anything on screen move from frame a to frame b? The dots count when
// the orb drew a frame and they went a visible distance.
function movedBetween(a, b) {
  const dots = Boolean(b.sphere && ((b.orb && a.orb && b.orb.frame > a.orb.frame && b.orb.mean > 0.12) || (b.pix != null && a.pix != null && b.pix !== a.pix)));
  const lava = Boolean((a.lava || b.lava) && (!a.lava || !b.lava || !near(a.lava.r, b.lava.r) || Math.abs(a.lava.o - b.lava.o) > 0.004));
  const card = Boolean((a.box || b.box) && (!a.box || !b.box || Math.abs(a.box.o - b.box.o) > 0.003 || !near(a.box.title, b.box.title)));
  const sphere = !near(a.stage, b.stage);
  const line = Math.abs(a.lineO - b.lineO) > 0.003;
  return { any: dots || lava || card || sphere || line, dots };
}

// The stretch from the owner's Enter on their answer to the idea at rest,
// as numbers: the longest still moment, the biggest one-frame steps and the
// biggest change of speed (a snap), and what each part showed. Steps and
// changes of speed are per 60fps frame, read on the clock each part moves by,
// so a slower machine reads the same: the dots and the lava on their own
// clocks, everything else on the frame's own time. The machine's pace is its
// 75th percentile frame: a slow machine slows most frames, while a few stalls
// cannot move it. A frame over twice that pace (never under 50ms, never over
// 250ms) is a stall, and what moves in it counts at its full distance.
function summarizeWait(frames, from, idea) {
  const run = frames.filter(f => f.t >= from);
  const end = run.findIndex(f => f.box && f.box.titleText === idea && !f.busy && f.box.o > 0.99);
  const span = end < 0 ? run : run.slice(0, end + 1);
  const gaps = span.slice(1).map((f, i) => f.ft - span[i].ft).sort((x, y) => x - y);
  const pace = gaps.length ? gaps[Math.floor(0.75 * (gaps.length - 1))] : 16.7;
  const stall = Math.min(250, Math.max(50, 2 * pace));
  const per = ms => (ms > stall ? 1 : 16.7 / Math.max(8, ms));
  let still = 0, stillAt = null, runStart = span.length ? span[0].t : 0, stillWaiting = 0;
  let lavaStep = 0, lavaGrow = 0, lavaJerk = 0, stageStep = 0, dotsStep = 0, dotsJerk = 0, titleStep = 0, footJump = 0;
  let prevLava = null, prevDots = null;
  let dotFrames = 0, dotsMs = 0;
  for (let i = 1; i < span.length; i++) {
    const a = span[i - 1], b = span[i];
    const ms = b.ft - a.ft, k = per(ms);
    const m = movedBetween(a, b);
    if (m.dots) { dotFrames += 1; dotsMs += Math.min(ms, stall); }
    if (m.any) runStart = b.t;
    else if (b.t - runStart > still) { still = b.t - runStart; stillAt = Math.round(runStart - from); }
    if (!m.any && (b.waiting || (b.sphere && !b.box)) && b.t - runStart > stillWaiting) stillWaiting = b.t - runStart;
    if (a.lava && b.lava && a.lava.at === b.lava.at && near(a.lava.r, b.lava.r)) {
      // not placed again since the last read: no new sample of its motion
    } else if (a.lava && b.lava) {
      // the lava is read where its last place put it, so its time is that place's
      const own = a.lava.at != null && b.lava.at != null ? b.lava.at - a.lava.at : ms, kl = per(own);
      const st = stepOf(mid(a.lava.r), mid(b.lava.r)) * kl;
      lavaStep = Math.max(lavaStep, st);
      lavaGrow = Math.max(lavaGrow, Math.abs(a.lava.r.w - b.lava.r.w) * kl);
      // a change of speed between two frames, per 60fps frame of the time between them
      if (prevLava) lavaJerk = Math.max(lavaJerk, Math.abs(st - prevLava.st) * per((prevLava.own + own) / 2));
      prevLava = { st, own };
    } else prevLava = null;
    if (a.stage && b.stage) stageStep = Math.max(stageStep, stepOf(a.stage, b.stage) * k, Math.abs(a.stage.w - b.stage.w) * k);
    if (b.orb && a.orb && b.orb.frame > a.orb.frame && a.sphere && b.sphere) {
      // the orb counts its own frames and its own clock: its step is for one
      // frame of that clock, which never runs more than 50ms a frame
      const drawn = b.orb.frame - a.orb.frame, own = Math.max(8, b.orb.ms || 0);
      dotsStep = Math.max(dotsStep, b.orb.step * 16.7 / own);
      const speed = b.orb.mean * 16.7 / own;
      if (prevDots && drawn === 1) dotsJerk = Math.max(dotsJerk, Math.abs(speed - prevDots.speed) * 16.7 / ((prevDots.own + own) / 2));
      prevDots = drawn === 1 ? { speed, own } : null;
    } else prevDots = null;
    if (a.box && b.box && a.box.card === b.box.card && a.box.title && b.box.title) titleStep = Math.max(titleStep, stepOf(a.box.title, b.box.title) * k);
    // the footer may change places only while it cannot be seen
    if (stepOf(a.foot.r, b.foot.r) > 2 && Math.min(a.foot.o, b.foot.o) > 0.05) footJump = Math.max(footJump, stepOf(a.foot.r, b.foot.r));
  }
  const calm = span.filter(f => f.waiting);
  const bloom = span.findIndex((f, i) => i > 0 && f.lava && !span[i - 1].lava && span[i - 1].waiting);
  const born = bloom > 0 ? span[bloom] : null;
  const before = bloom > 0 ? span[bloom - 1] : null;
  return {
    ms: span.length ? Math.round(span[span.length - 1].t - from) : null,
    reached_idea: end >= 0,
    // nothing on screen moved for this long, at most
    longest_still_ms: Math.round(still),
    longest_still_at_ms: stillAt,
    // and while the owner waited (the sphere up, or the calm line)
    longest_still_waiting_ms: Math.round(stillWaiting),
    dot_frames: dotFrames,
    // how much of the wait the dots were moving through, however many frames that took
    dots_moving_ms: Math.round(dotsMs),
    // the machine's pace, and the frame length past which a frame is a stall
    pace_frame_ms: Math.round(pace),
    stall_frame_ms: Math.round(stall),
    // one-frame steps and changes of speed, in css pixels
    lava_max_step_px: round(lavaStep),
    lava_max_size_step_px: round(lavaGrow),
    lava_max_speed_change_px: round(lavaJerk),
    sphere_max_step_px: round(stageStep),
    dots_max_step_px: round(dotsStep),
    dots_max_speed_change_px: round(dotsJerk),
    title_max_step_px: round(titleStep),
    footer_seen_jump_px: round(footJump),
    // the calm line: its box open every frame, the live words, the notes
    calm_frames: calm.length,
    calm_box_open: calm.length > 0 && calm.every(f => f.field),
    calm_steps: [...new Set(calm.map(f => f.step).filter(Boolean))],
    calm_notes: calm.length ? calm[calm.length - 1].notes : [],
    lines: [...new Set(span.map(f => f.line).filter(Boolean))],
    // the idea is born where the dots were
    bloom_from_dots_px: born && before && before.stage ? round(stepOf(mid(born.lava.r), mid(before.stage))) : null,
    // under reduced motion: how many frames the dots drew, and how many frames a card was part way faded
    orb_frames_drawn: span.length && span[span.length - 1].orb && span[0].orb ? span[span.length - 1].orb.frame - span[0].orb.frame : null,
    fading_frames: span.filter(f => f.box && f.box.o > 0.05 && f.box.o < 0.95).length,
  };
}

// The owner types their own answer into "something else". The Mac reads it
// for readMs, says got it, and has no idea ready: the calm line comes, its
// live words moving on while the idea is written. The owner types a note
// there and the card says it is folded in; the note is the next post, on the
// calm line's own id. After writeMs the idea is ready and grows out of the
// dots. Every frame from the answer to the idea at rest is kept.
// note: false skips the note (a page from before the calm line took one)
async function waitTrace({ chromePath = findChrome(), reduced = false, shots = null, page = phonePage, readMs = 900, writeMs = 3200, note = true } = {}) {
  const started = Date.now() - 4000;
  let lines = CALM_LINES.slice(0, 1);
  let notes = [];
  let ready = false;
  // the calm line as the desk serves it: its drafting lines with when each came, when it began, how long ago
  const calm = () => gmCard.wait({ id: 'wait:7', progress: lines.map((line, i) => ({ at: started + i * 1100, line })), started_at: started, waited_ms: Date.now() - started, thread: notes.length ? [...notes.map(text => ({ who: 'owner', text })), { who: 'orb', text: FOLDED }] : [] });
  const posts = [];
  const desk = cardDesk(CARDS.q1, async (action, { card, text, body }) => {
    posts.push({ action, card: body.card_id || null, text: text || null });
    if (action === 'say' && card.kind === 'question') { await wait(readMs); return { card: calm(), ack: `got it: ${text}.` }; }
    if (action === 'say' && card.kind === 'wait') { notes = [...notes, text]; return { card: calm(), ack: FOLDED }; }
    if (action === 'orb') return { card: ready ? CARDS.b1 : calm() };
    return { card };
  }, { queue: () => (ready ? 1 : 0) });
  return onPhone(desk, chromePath, async (p, send) => {
    const shot = async (name) => {
      if (!shots) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, `${reduced ? 'r-' : ''}${name}.png`), Buffer.from(data, 'base64'));
    };
    await p.run(WAIT_RECORDER);
    await p.tap('#bet .choice.other');
    await wait(250);
    await p.type('paying schools');
    await shot('w1-typed');
    await p.enter();
    const sentAt = (await p.run('window.__wait.marks'))[0].t;
    await wait(120);
    await shot('w2-held');
    await p.until("document.getElementById('line').textContent.indexOf('got it') === 0", 'got it', 6000);
    await wait(150);
    await shot('w3-got-it');
    await wait(450);
    await shot('w4-got-it-later');
    await p.until(`document.getElementById('bet').getAttribute('data-kind') === 'wait' && !document.body.hasAttribute('data-busy') && Number(getComputedStyle(document.getElementById('bet')).opacity) > 0.99`, 'the calm line', 8000);
    const calmAt = Date.now();
    // the writer moves on while the owner looks
    const moving = setInterval(() => {
      if (lines.length < CALM_LINES.length) lines = CALM_LINES.slice(0, lines.length + 1);
      if (desk.current && desk.current.kind === 'wait') desk.current = calm();
    }, 1100);
    try {
      await shot('w5-calm');
      await wait(700);
      await shot('w6-calm-later');
      // a note while it writes
      if (note) {
        await p.tap('#bet .sayline .field input');
        await wait(150);
        await p.type('make it about schools');
        await shot('w7-note-typing');
        await p.enter();
        await p.until(`Array.prototype.some.call(document.querySelectorAll('#bet .waitnotes .turn'), function (n) { return n.textContent === ${JSON.stringify(FOLDED)}; })`, 'the note folded in', 6000);
        await wait(400);
        await shot('w8-note-folded');
      }
      const left = writeMs - (Date.now() - calmAt);
      if (left > 0) await wait(left);
      ready = true;
      if (shots) {
        await p.until("!document.body.classList.contains('waiting')", 'the idea landing', 8000);
        await wait(60);
        await shot('w9-landing');
      }
      await p.until(`${titled(CARDS.b1.title)}`, 'the idea', 10000);
      await wait(300);
      await shot('w10-idea');
    } finally {
      clearInterval(moving);
    }
    await p.run('window.__wait.on = false');
    const frames = await p.run('window.__wait.frames');
    return { reduced, viewport: `${PHONE.width}x${PHONE.height}`, frames: frames.length, posts, ...summarizeWait(frames, sentAt, CARDS.b1.title) };
  }, PHONE, { reduced, page });
}

// ---- the calm line's layout at a phone, a large phone, and a laptop --------------------------

const BIG_PHONE = { width: 430, height: 932, deviceScaleFactor: 3, mobile: true };

// Where the calm line's parts sit, in css pixels: the box and its send
// button against the screen's edges, and the middle of the words actually
// drawn in the title and in "the team" (a range over the text, not the
// full-width line it sits in). With note: one note and its answer on it.
const CALM_LAYOUT = `(function () {
  function rect(n) { if (!n) return null; var b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }
  function words(n) {
    if (!n) return null;
    var r = document.createRange(); r.selectNodeContents(n);
    var rs = Array.prototype.slice.call(r.getClientRects());
    if (!rs.length) return null;
    var left = Math.min.apply(null, rs.map(function (x) { return x.left; })), right = Math.max.apply(null, rs.map(function (x) { return x.right; }));
    return { left: left, right: right, mid: (left + right) / 2, top: Math.min.apply(null, rs.map(function (x) { return x.top; })), bottom: Math.max.apply(null, rs.map(function (x) { return x.bottom; })) };
  }
  var box = document.getElementById('bet');
  return {
    vw: document.documentElement.clientWidth,
    vh: window.innerHeight,
    scroll_w: document.documentElement.scrollWidth,
    card: rect(box),
    field: rect(box.querySelector('.sayline .field')),
    send: rect(box.querySelector('.sayline .field .send')),
    title: words(box.querySelector('h1')),
    team: words(document.getElementById('working')),
    stage: rect(document.getElementById('stage')),
    foot: rect(document.getElementById('foot')),
  };
})()`;

async function calmLayoutTrace({ chromePath = findChrome(), viewports = [PHONE, BIG_PHONE, LAPTOP], shots = null } = {}) {
  const out = [];
  for (const viewport of viewports) {
    const started = Date.now() - 14000;
    const calm = gmCard.wait({ id: 'wait:5', progress: [{ at: started, line: 'drafting three ideas at once' }], started_at: started, waited_ms: 14000, thread: [{ who: 'owner', text: 'make it about schools' }, { who: 'orb', text: FOLDED }] });
    const desk = cardDesk(calm, async (a, { card }) => ({ card }));
    out.push(await onPhone(desk, chromePath, async (p, send) => {
      await p.until("document.body.classList.contains('waiting') && Boolean(document.querySelector('#bet .sayline .field'))", 'the calm line', 8000);
      await wait(900);
      const at = { viewport: `${viewport.width}x${viewport.height}`, ...(await p.run(CALM_LAYOUT)) };
      if (shots) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, `calm-${viewport.width}.png`), Buffer.from(data, 'base64'));
      }
      return at;
    }, viewport, { firstCard: false }));
  }
  return out;
}

module.exports = { findChrome, launch, trace, waitTrace, summarizeWait, calmLayoutTrace, BIG_PHONE, CALM_LINES, twoMembersTrace, deckTrace, escapeTrace, staleAnswerTrace, unsentSayTrace, replyKeepsActionTrace, lostReplyTrace, talkFailTrace, startFailTrace, orbHomeTrace, teamTableTrace, engineCardTrace, walkTrace, onPhone, cardDesk, CARDS, REPLY, PHONE, LAPTOP };

if (require.main === module) {
  const at = process.argv.indexOf('--shots');
  const shots = at > 0 ? path.resolve(process.argv[at + 1] || 'gm-phone-shots') : null;
  const fail = (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); };
  if (process.argv.includes('--engine')) {
    (async () => {
      const out = [];
      for (const viewport of [PHONE, LAPTOP]) out.push(await engineCardTrace({ viewport, shots }));
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    })().catch(fail);
  } else if (process.argv.includes('--wait')) {
    (async () => {
      const out = [];
      for (const reduced of [false, true]) out.push(await waitTrace({ reduced, shots }));
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    })().catch(fail);
  } else if (process.argv.includes('--team')) {
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

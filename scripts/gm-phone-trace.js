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

const TEAM_ROWS = [{ member: 'builder', status: 'not running', on: 'the getting started page', time: 'last seen 2h ago' }];

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

// Opens the team from the card, a member's talk card from a row, types a
// word to them that arms a second tap, then presses Esc until the card is
// back and once more. Each step reads the layer, so "Esc steps back one
// layer" is a list of states.
async function escapeTrace({ chromePath = findChrome() } = {}) {
  if (!chromePath) throw new Error('no chrome found; set CHROME_PATH');
  const desk = { ...scriptedDesk(), teamTable: () => ({ ok: true, rows: TEAM_ROWS }), talk: ({ confirm }) => (confirm ? { ok: true, ack: 'builder has it.' } : { ok: false, reason: 'needs_confirm', message: 'tap again to start builder on this' }) };
  const server = await serve(desk);
  let chrome = null;
  try {
    chrome = await launch(chromePath);
    const { send } = chrome;
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await send('Page.enable');
    await send('Page.navigate', { url: server.url });
    const p = driver(send);
    const settled = "document.body.classList.contains('has-card') && !document.querySelector('.bet.ghost') && !document.getElementById('bet').classList.contains('turning')";
    await p.until(`document.readyState === 'complete' && ${settled} && Boolean(document.querySelector('#bet h1'))`, 'the first card');
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
    await p.tap('#team .row');
    await p.until("Boolean(document.querySelector('#team input'))", 'the talk card');
    await p.tap('#team input');
    await p.type('take the readme first');
    await p.enter();
    await p.until("document.querySelector('#team .sayline .pill').textContent === 'tap again'", 'the armed second tap');
    await look('typing to builder');
    for (let i = 1; i <= 4; i++) { await esc(); await look(`esc ${i}`); }
    return { viewport: `${PHONE.width}x${PHONE.height}`, steps };
  } finally {
    if (chrome) chrome.close();
    await server.close();
  }
}

module.exports = { findChrome, trace, escapeTrace, REPLY };

if (require.main === module) {
  const at = process.argv.indexOf('--shots');
  trace({ shots: at > 0 ? path.resolve(process.argv[at + 1] || 'gm-phone-shots') : null }).then((out) => {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (out.failed) process.exitCode = 1;
  }, (err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}

'use strict';

const assert = require('node:assert/strict');
const gmCard = require('../lib/gm-card');

const wait = ms => new Promise(r => setTimeout(r, ms));

// what the card on screen is, where the focus is, and what the page says
const LOOK = `(function () {
  var b = document.getElementById('bet');
  var h = b.querySelector('h1');
  var n = b.querySelector('.act .note');
  var a = document.activeElement;
  return {
    card: b.getAttribute('data-card'),
    title: h ? h.textContent : null,
    note: n ? n.textContent : null,
    busy: document.body.hasAttribute('data-busy'),
    has_card: document.body.classList.contains('has-card') && !b.hidden,
    line: document.getElementById('line').textContent,
    active: a ? a.tagName + (a.getAttribute('data-option') ? ':' + a.getAttribute('data-option') : '') + (a.id ? '#' + a.id : '') : null,
    armed: Array.prototype.map.call(b.querySelectorAll('.armed'), function (x) { return x.textContent; }),
    field: Boolean(b.querySelector('.field')),
  };
})()`;
const look = p => p.run(LOOK);

// a press and a release on the middle of sel, as one tap
async function tapAt(send, x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}
// a tap on the button that reads label, wherever it is on the card
async function tapText(p, send, label) {
  const r = await p.run(`(function () { var n = Array.prototype.find.call(document.querySelectorAll('#bet button, .foot button'), function (b) { return b.textContent === ${JSON.stringify(label)} && b.offsetParent; }); if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  assert.ok(r, `no button reads ${label}`);
  await tapAt(send, r.x, r.y);
}

// The page again with its long waits cut a hundredfold (anything set for 15
// seconds or more), so a give-up the page makes after a minute and a half
// shows in about a second. Only timers that long are touched.
async function quickClock(p, send, ready = "Boolean(document.querySelector('#bet h1')) && !document.body.hasAttribute('data-busy')") {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(function () { var st = window.setTimeout; window.setTimeout = function (f, ms) { var rest = Array.prototype.slice.call(arguments, 2); return st.apply(window, [f, ms >= 15000 ? ms / 100 : ms].concat(rest)); }; })()' });
  await send('Page.reload', {});
  await wait(300);
  await p.until(`document.readyState === 'complete' && ${ready}`, 'the page again', 8000);
}

// the card on screen reads this title, at rest
const titled = t => `!document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1')) && document.querySelector('#bet h1').textContent === ${JSON.stringify(t)}`;

const deckCard = (n = 1) => gmCard.deck({ id: `deck~${n}`, at: 0, total: 2, card: { job_id: 'm1', mission_id: 'm1', member: 'builder', label: 'working', time: 'about 4 hours left', rows: [{ done: 'not yet', work: 'split the big test file', member: 'builder', role: 'builder', status: 'working' }] }, columns: ['done', 'work', 'member', 'role', 'status'], job: { member: 'builder', role: 'builder' } });

const teamOf = (n = 1) => gmCard.team({ id: `team~${n}`, rows: [{ member: 'navigator', role: 'system navigator', ovr: '84', engine: 'tool one m-small', status: 'waiting for your yes', sentence: 'waiting for your yes: plan the pricing page, waiting 2 hours' }], line: null, deck: false });

module.exports = { wait, look, tapAt, tapText, quickClock, titled, deckCard, teamOf };

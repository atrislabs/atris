'use strict';

// How the orb page answers the owner's hands and trouble: taps, keys, the
// back button, a phone coming back from the lock screen, and a network or a
// Mac that fails. Every test drives the real page in headless Chrome through
// scripts/gm-phone-trace.js, with a desk that speaks the one card contract.

const test = require('node:test');
const assert = require('node:assert/strict');

const trace = require('../scripts/gm-phone-trace');
const gmCard = require('../lib/gm-card');

const CHROME = trace.findChrome();
const { CARDS } = trace;
const skip = !CHROME && 'no chrome on this machine';
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
async function middle(p, sel) {
  const r = await p.rect(sel);
  assert.ok(r, `nothing at ${sel}`);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

test('browser: a fumbled double tap on do it only arms it; a real second tap starts it', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const at = await middle(p, '#bet .pill');
    // two taps 90ms apart, the way a thumb double taps
    await tapAt(send, at.x, at.y, 1);
    await wait(90);
    await tapAt(send, at.x, at.y, 2);
    await wait(700);
    const doubled = { did: [...did], ...(await look(p)) };
    // the second tap of someone who read "tap again to start"
    await tapAt(send, at.x, at.y);
    await p.until(`document.querySelector('#bet h1') && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b2.title)}`, 'the next card', 8000);
    return { doubled, did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual(out.doubled.did, [], show);
  assert.deepEqual(out.doubled.armed, ['tap again to start'], show);
  assert.equal(out.doubled.title, CARDS.b1.title, show);
  assert.deepEqual(out.did, ['do'], show);
});

'use strict';

// How every card sits on the screen, measured from the boxes the real page
// draws in headless Chrome (scripts/gm-phone-layout.js): phones small and
// large, a phone on its side, a laptop, with and without a notch.

const test = require('node:test');
const assert = require('node:assert/strict');
const trace = require('../scripts/gm-phone-trace');
const { layout, CASES } = require('../scripts/gm-phone-layout');

const CHROME = trace.findChrome();
const skip = !CHROME && 'no chrome on this machine';
const only = (...names) => CASES.filter(c => names.includes(c.name));

test('layout: on the swap card every model\'s note sits on its own line under its name', { skip, timeout: 90000 }, async () => {
  const probe = `Array.prototype.map.call(document.querySelectorAll('#bet button.choice'), function (b) {
    var t = b.querySelector('.t'), w = b.querySelector('.w');
    if (!t || !w) return null;
    var a = t.getBoundingClientRect(), c = w.getBoundingClientRect();
    return { name: t.textContent, note: w.textContent, name_bottom: a.bottom, note_top: c.top, note_left: c.left, name_left: a.left };
  }).filter(Boolean)`;
  const rows = await layout({ chromePath: CHROME, cases: only('swap'), viewports: ['phone', 'small'], probe });
  for (const r of rows) {
    const show = JSON.stringify(r.probe, null, 1);
    assert.equal(r.probe.length, 3, show);
    for (const m of r.probe) {
      assert.ok(m.note_top >= m.name_bottom - 0.5, show);
      assert.ok(Math.abs(m.note_left - m.name_left) <= 0.5, show);
    }
  }
});

test('layout: on a phone with a notch the small orb rests below it, as far above the card as on a phone without one', { skip, timeout: 90000 }, async () => {
  const rows = await layout({ chromePath: CHROME, cases: only('idea', 'deck'), viewports: ['phone', 'big', 'small'] });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.viewport}`, inset: r.safe_area, lava: r.lava, card: r.card && r.card.top })), null, 1);
  const gaps = rows.map(r => r.card.top - r.lava.bottom);
  for (const r of rows) assert.ok(r.lava.top >= ((r.safe_area && r.safe_area.top) || 0) + 8, show);
  // the notched phones (47px and 59px) keep the gap of the 320px phone with none
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, show);
});

test('layout: the big orb\'s line ends above the footer at every size, a phone on its side too', { skip, timeout: 90000 }, async () => {
  const rows = await layout({ chromePath: CHROME, cases: only('home') });
  const show = JSON.stringify(rows.map(r => ({ at: r.size, stage: r.stage, line: r.line, foot: r.foot })), null, 1);
  assert.equal(rows.length, 5, show);
  for (const r of rows) {
    assert.ok(r.line.bottom <= r.foot.top, show);
    assert.equal(r.scroll_w, r.vw, show);
  }
  // an upright phone and the laptop keep their orb: 72% of the short side, at most 520px
  for (const r of rows.filter(x => x.viewport !== 'side')) assert.ok(Math.abs(r.stage.width - Math.min(0.72 * Math.min(r.vw, r.vh), 520)) <= 1, show);
});

test('layout: on the calm line the footer never lands on the card, with the phone on its side or a note open, and the sphere stays put', { skip, timeout: 120000 }, async () => {
  const probe = `(function () {
    function R(n) { var b = n.getBoundingClientRect(); return { top: b.top + scrollY, bottom: b.bottom + scrollY }; }
    var b = document.getElementById('bet');
    return { field: R(b.querySelector('.field')), time: R(b.querySelector('.waittime')), foot: R(document.getElementById('foot')), stage: R(document.getElementById('stage')), card_top: R(b).top };
  })()`;
  const rows = await layout({ chromePath: CHROME, cases: only('wait', 'wait-notes'), probe });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, ...r.probe })), null, 1);
  for (const r of rows) {
    const p = r.probe;
    // the box and every line of words end above the footer, and the sphere above the card
    assert.ok(p.field.bottom <= p.foot.top, show);
    assert.ok(p.time.bottom <= p.foot.top, show);
    assert.ok(p.stage.bottom <= p.card_top, show);
    assert.equal(r.scroll_w, r.vw, show);
  }
  // upright phones and the laptop keep the footer at the bottom of the screen
  for (const r of rows.filter(x => x.case === 'wait' && x.viewport !== 'side')) assert.ok(Math.abs(r.probe.foot.bottom - (r.vh - Math.max(20, (r.safe_area && r.safe_area.bottom) || 0))) <= 1, show);
});

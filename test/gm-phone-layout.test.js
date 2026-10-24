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

test('layout: with a notched phone on its side the wide cards start past the notch, and upright phones keep 24px sides', { skip, timeout: 90000 }, async () => {
  const rows = await layout({ chromePath: CHROME, cases: only('team', 'deck', 'idea'), viewports: ['side', 'phone', 'small'] });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, inset: r.safe_area, card: r.card })), null, 1);
  for (const r of rows) {
    const inset = r.safe_area || {};
    const side = Math.max(24, inset.left || 0, inset.right || 0);
    assert.ok(r.card.left >= Math.max(24, inset.left || 0) - 0.5, show);
    assert.ok(r.vw - r.card.right >= Math.max(24, inset.right || 0) - 0.5, show);
    if (r.viewport !== 'side') assert.equal(r.card.left, 24, show);
    else if (r.case !== 'idea') assert.ok(Math.abs(r.card.left - side) <= 0.5, show);
    assert.equal(r.scroll_w, r.vw, show);
  }
});

// every row of small links on the card: its lines (by the links on them),
// whether a dot that shows sits between two links on one line, and each
// line's middle against the card's
const LINK_ROWS = `Array.prototype.filter.call(document.querySelectorAll('#bet .links'), function (row) { return row.querySelector('button'); }).map(function (row) {
  var card = document.getElementById('bet').getBoundingClientRect();
  var lines = {};
  Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) {
    var r = b.getBoundingClientRect(), k = Math.round(r.top);
    lines[k] = lines[k] || { left: Infinity, right: -Infinity, bottom: r.bottom, links: [] };
    lines[k].left = Math.min(lines[k].left, r.left); lines[k].right = Math.max(lines[k].right, r.right); lines[k].links.push(b.textContent);
  });
  // a group's heading words ("who it is for:") are part of their line
  if (row.firstChild && row.firstChild.nodeType === 3) {
    var range = document.createRange(); range.selectNode(row.firstChild);
    Array.prototype.forEach.call(range.getClientRects(), function (t) {
      var mid = (t.top + t.bottom) / 2;
      Object.keys(lines).forEach(function (k) { if (mid >= Number(k) && mid <= lines[k].bottom) { lines[k].left = Math.min(lines[k].left, t.left); lines[k].right = Math.max(lines[k].right, t.right); } });
    });
  }
  var dots = Array.prototype.filter.call(row.querySelectorAll('.sep'), function (s) { return getComputedStyle(s).display !== 'block'; }).map(function (s) {
    var a = s.previousElementSibling.getBoundingClientRect(), z = s.nextElementSibling.getBoundingClientRect();
    return { between: s.previousElementSibling.textContent + ' | ' + s.nextElementSibling.textContent, one_line: Math.abs(a.top - z.top) <= 1 };
  });
  return { lines: Object.keys(lines).map(function (k) { var l = lines[k]; return { links: l.links, off_center: Math.round(((l.left + l.right) / 2 - (card.left + card.right) / 2) * 10) / 10 }; }), dots: dots };
})`;

test('layout: a row of small links that wraps keeps every dot between two links on one line, and every line is centered', { skip, timeout: 90000 }, async () => {
  const rows = await layout({ chromePath: CHROME, cases: only('deck', 'swap', 'idea', 'reply'), viewports: ['phone', 'small', 'laptop'], probe: LINK_ROWS });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, rows: r.probe })), null, 1);
  let wrapped = 0;
  for (const r of rows) {
    for (const row of r.probe) {
      if (row.lines.length > 1) wrapped += 1;
      for (const d of row.dots) assert.ok(d.one_line, show);
      // the side of a link's own space (the dot and its gaps) is the only give
      for (const l of row.lines) assert.ok(Math.abs(l.off_center) <= 8, show);
    }
  }
  // the deck's five links wrap on the phones, so the case is really measured
  assert.ok(wrapped >= 2, show);
});

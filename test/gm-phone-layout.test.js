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


// every title, body, line, and label to read on the card: how many lines
// it takes and the words on its last line
const LAST_LINES = `Array.prototype.map.call(document.querySelectorAll('#bet h1, #bet .why, #bet .mission, #bet .option .t, #bet .option .w, #bet .choice .w, #bet button.choice:not(:has(.t))'), function (n) {
  var words = [], walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  for (var t = walker.nextNode(); t; t = walker.nextNode()) {
    var re = /\\S+/g, m;
    while ((m = re.exec(t.textContent))) {
      var r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length);
      var rects = Array.prototype.filter.call(r.getClientRects(), function (x) { return x.width > 0; });
      // a word too long for a line (an email address) breaks across lines; it counts where it ends
      if (rects.length) words.push({ w: m[0], top: Math.round(rects[rects.length - 1].top), broken: Math.round(rects[0].top) !== Math.round(rects[rects.length - 1].top) });
    }
  }
  var tops = [];
  words.forEach(function (x) { if (tops.indexOf(x.top) < 0) tops.push(x.top); });
  var lastWords = words.filter(function (x) { return x.top === tops[tops.length - 1]; });
  var last = lastWords.map(function (x) { return x.w; });
  return { what: n.tagName.toLowerCase() + '.' + n.className, lines: tops.length, words: words.length, last: last.join(' '), broken: lastWords.some(function (x) { return x.broken; }) };
})`;

test('layout: no title, body, or label leaves one word alone on its last line, on any card at any size', { skip, timeout: 180000 }, async () => {
  const rows = await layout({ chromePath: CHROME, viewports: ['phone', 'small', 'side', 'laptop'], probe: LAST_LINES });
  const alone = [];
  let wrapped = 0;
  for (const r of rows) for (const p of r.probe) {
    if (p.lines < 2 || p.broken) continue;
    wrapped += 1;
    if (p.last.split(' ').length < 2) alone.push(`${r.case} ${r.size} ${p.what}: ${p.last}`);
  }
  assert.deepEqual(alone, []);
  assert.ok(wrapped >= 40, String(wrapped));
});

test('layout: the calm line\'s open box shows its whole hint on every phone, centered where there is room and from the left on narrow ones', { skip, timeout: 90000 }, async () => {
  const probe = `(function () {
    var i = document.querySelector('#bet .field input');
    var s = getComputedStyle(i), c = document.createElement('canvas').getContext('2d');
    c.font = s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily;
    return { hint_px: c.measureText(i.placeholder).width, room_px: i.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), align: s.textAlign };
  })()`;
  const mini = { name: 'mini', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, notch: null };
  const rows = await layout({ chromePath: CHROME, cases: only('wait'), viewports: ['small', mini, 'phone', 'big', 'laptop'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: r.size, ...r.probe })), null, 1);
  for (const r of rows) assert.ok(r.probe.room_px >= r.probe.hint_px, show);
  assert.deepEqual(rows.map(r => r.probe.align), ['left', 'left', 'center', 'center', 'center'], show);
});

test('layout: an open box\'s edge is at least 3:1 against the page and every line of words at least 4.5:1, on every card', { skip, timeout: 120000 }, async () => {
  const probe = `Array.prototype.map.call(document.querySelectorAll('#bet .field'), function (f) {
    function lum(c) { var v = String(c).match(/[\\d.]+/g).slice(0, 3).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }
    var a = lum(getComputedStyle(f).borderTopColor), b = lum(getComputedStyle(document.body).backgroundColor);
    return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  })`;
  const rows = await layout({ chromePath: CHROME, viewports: ['phone'], probe });
  const boxes = rows.filter(r => r.probe.length);
  const show = JSON.stringify(rows.map(r => ({ at: r.case, edges: r.probe, low: r.words_low })), null, 1);
  assert.ok(boxes.length >= 1, show);
  for (const r of boxes) for (const edge of r.probe) assert.ok(edge >= 3, show);
  for (const r of rows) assert.deepEqual(r.words_low, [], show);
});

test('layout: the phone\'s own text enlarging is off, so the words keep their sizes when the phone turns', { skip, timeout: 90000 }, async () => {
  const probe = `({ adjust: getComputedStyle(document.documentElement).textSizeAdjust, body: parseFloat(getComputedStyle(document.querySelector('#bet .why')).fontSize), quiet: parseFloat(getComputedStyle(document.querySelector('#bet .links button')).fontSize) })`;
  const rows = await layout({ chromePath: CHROME, cases: only('idea'), viewports: ['phone', 'side'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: r.size, ...r.probe })), null, 1);
  for (const r of rows) assert.equal(r.probe.adjust, '100%', show);
  assert.deepEqual(rows.map(r => [r.probe.body, r.probe.quiet]), [[20, 17], [20, 17]], show);
});

test('layout: an answer that wraps keeps its lines at 1.3, so one long answer reads as one', { skip, timeout: 90000 }, async () => {
  const probe = `Array.prototype.map.call(document.querySelectorAll('#bet button.choice'), function (b) {
    var s = getComputedStyle(b), r = document.createRange(); r.selectNodeContents(b);
    var tops = {}; Array.prototype.forEach.call(r.getClientRects(), function (x) { tops[Math.round(x.top)] = 1; });
    return { label: b.textContent, lines: Object.keys(tops).length, ratio: Math.round(parseFloat(s.lineHeight) / parseFloat(s.fontSize) * 100) / 100, height: b.getBoundingClientRect().height };
  })`;
  const rows = await layout({ chromePath: CHROME, cases: only('question-long', 'reply'), viewports: ['phone', 'small'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, answers: r.probe })), null, 1);
  const all = rows.flatMap(r => r.probe);
  assert.ok(all.some(a => a.lines >= 2), show);
  for (const a of all) assert.equal(a.ratio, 1.3, show);
  // a one-line answer still has its full tap height
  for (const a of all.filter(x => x.lines === 1)) assert.ok(a.height >= 52, show);
});

test('layout: the words inside every box start the same distance in: answers, idea choices, and open boxes', { skip, timeout: 90000 }, async () => {
  const probe = `Array.prototype.map.call(document.querySelectorAll('#bet button.choice, #bet button.option, #bet .field'), function (b) {
    var i = b.querySelector('input');
    var left;
    if (i) left = i.getBoundingClientRect().left + parseFloat(getComputedStyle(i).paddingLeft);
    else { var r = document.createRange(); r.selectNodeContents(b); left = r.getClientRects()[0].left; }
    return { what: b.className, inset: Math.round((left - b.getBoundingClientRect().left) * 10) / 10 };
  })`;
  const rows = await layout({ chromePath: CHROME, cases: only('question', 'choice', 'swap', 'wait'), viewports: ['small'], probe });
  const all = rows.flatMap(r => r.probe);
  const show = JSON.stringify(all, null, 1);
  assert.deepEqual([...new Set(all.map(b => b.what.split(' ')[0]))].sort(), ['choice', 'field', 'option'], show);
  for (const b of all) assert.equal(b.inset, 17, show);
});

test('layout: outside the team table the cards use three type sizes: 17 for quiet lines, 20 for what you read or answer, and the title', { skip, timeout: 120000 }, async () => {
  const probe = `(function () {
    var sizes = {};
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var t = walker.nextNode(); t; t = walker.nextNode()) {
      var p = t.parentElement;
      if (!String(t.textContent).trim() || !p || p.closest('.grid') || p.closest('[aria-hidden="true"]') || !p.closest('#bet, #foot, #line')) continue;
      var s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || !p.getBoundingClientRect().width) continue;
      var h = p.closest('#bet h1');
      var px = parseFloat(s.fontSize);
      sizes[h && !h.classList.contains('said') ? 'title' : String(px)] = true;
    }
    var i = document.querySelector('#bet .field input');
    if (i) sizes[String(parseFloat(getComputedStyle(i).fontSize))] = true;
    return Object.keys(sizes).sort();
  })()`;
  const rows = await layout({ chromePath: CHROME, viewports: ['phone'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: r.case, sizes: r.probe })), null, 1);
  for (const r of rows) for (const size of r.probe) assert.ok(['17', '20', 'title'].includes(size), show);
  // the reply with its conversation really shows turns, answers, links, and its words
  const reply = rows.find(r => r.case === 'reply-thread');
  assert.deepEqual(reply.probe, ['17', '20'], show);
});


test('layout: in the team and job tables every cell of a row starts its words on one shared line', { skip, timeout: 90000 }, async () => {
  // a zero-size mark before each cell's first words sits on that line's baseline
  const probe = `Array.prototype.map.call(document.querySelectorAll('#bet tbody tr'), function (tr) {
  return Array.prototype.map.call(tr.cells, function (td) {
    var walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT), t = walker.nextNode();
    while (t && !String(t.textContent).trim()) t = walker.nextNode();
    if (!t) return null;
    var mark = document.createElement('span');
    mark.style.cssText = 'display:inline-block;width:0;height:0;';
    t.parentNode.insertBefore(mark, t);
    var y = mark.getBoundingClientRect().top;
    mark.remove();
    return Math.round(y * 10) / 10;
  });
})`;
  const rows = await layout({ chromePath: CHROME, cases: only('team', 'deck'), viewports: ['phone', 'laptop'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, baselines: r.probe })), null, 1);
  for (const r of rows) {
    assert.ok(r.probe.length >= 1, show);
    for (const row of r.probe) {
      const ys = row.filter(y => y != null);
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 1, show);
    }
  }
});

test('layout: a word longer than the screen, like an email address, breaks inside the card instead of pushing the page sideways', { skip, timeout: 90000 }, async () => {
  const probe = `(function () {
    var card = document.getElementById('bet').getBoundingClientRect(), out = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#bet h1, #bet .why'), function (n) {
      var r = document.createRange(); r.selectNodeContents(n);
      Array.prototype.forEach.call(r.getClientRects(), function (x) { out = Math.max(out, x.right - card.right); });
    });
    return Math.round(out * 10) / 10;
  })()`;
  const rows = await layout({ chromePath: CHROME, cases: only('yes-long-words'), viewports: ['small', 'phone', 'side', 'laptop'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: r.size, scroll_w: r.scroll_w, vw: r.vw, past_card_px: r.probe })), null, 1);
  for (const r of rows) {
    assert.equal(r.scroll_w, r.vw, show);
    assert.ok(r.probe <= 0.5, show);
  }
});

test('layout: the footer sits at the bottom of the screen on every card that fits, where it sits on the big orb, and 28px under a taller card', { skip, timeout: 180000 }, async () => {
  const probe = `(function () {
    // the footer's own box, so the check holds on the team card too, where its team link steps out
    var foot = document.getElementById('foot'), f = foot.getBoundingClientRect(), b = document.getElementById('bet');
    var c = b.hidden ? null : b.getBoundingClientRect();
    return { foot_bottom: Math.round((f.bottom + scrollY) * 10) / 10, foot_top: f.top + scrollY + parseFloat(getComputedStyle(foot).paddingTop), card_bottom: c ? c.bottom + scrollY : null, waiting: document.body.classList.contains('waiting') };
  })()`;
  const rows = await layout({ chromePath: CHROME, viewports: ['phone', 'big', 'small', 'laptop'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: `${r.case} ${r.size}`, ...r.probe })), null, 1);
  for (const v of ['phone', 'big', 'small', 'laptop']) {
    const at = rows.filter(r => r.viewport === v && !r.probe.waiting);
    const home = at.find(r => r.case === 'home');
    let fit = 0;
    for (const r of at.filter(x => x.case !== 'home')) {
      if (r.probe.card_bottom + 28 + 44 <= home.probe.foot_bottom) { fit += 1; assert.equal(r.probe.foot_bottom, home.probe.foot_bottom, show); } else assert.ok(r.probe.foot_top >= r.probe.card_bottom + 28 - 0.5, show);
    }
    assert.ok(fit >= 8, show);
  }
});

test('layout: when the team table scrolls sideways on a phone the name column keeps its heading over it', { skip, timeout: 90000 }, async () => {
  const probe = `(function () {
    var grid = document.querySelector('#bet .grid'), th = grid.querySelector('th.member'), td = grid.querySelector('td.member'), role = grid.querySelector('th.role');
    var before = th.getBoundingClientRect().left;
    grid.scrollLeft = 200;
    var out = { scrolled: grid.scrollLeft, head_moved: Math.abs(th.getBoundingClientRect().left - before), head_over_names: Math.abs(th.getBoundingClientRect().left - td.getBoundingClientRect().left), head_on_top: document.elementFromPoint(th.getBoundingClientRect().left + 10, th.getBoundingClientRect().top + 10) === th, role_left: role.getBoundingClientRect().left };
    grid.scrollLeft = 0;
    return out;
  })()`;
  const rows = await layout({ chromePath: CHROME, cases: only('team'), viewports: ['phone', 'small'], probe });
  const show = JSON.stringify(rows.map(r => ({ at: r.size, ...r.probe })), null, 1);
  for (const r of rows) {
    assert.ok(r.probe.scrolled >= 100, show);
    assert.ok(r.probe.head_moved <= 0.5, show);
    assert.ok(r.probe.head_over_names <= 0.5, show);
    assert.equal(r.probe.head_on_top, true, show);
  }
});

test('layout: on the team card the footer does not offer the team again; on every other card it does', { skip, timeout: 90000 }, async () => {
  const probe = `getComputedStyle(document.getElementById('working')).display !== 'none'`;
  const rows = await layout({ chromePath: CHROME, cases: only('home', 'idea', 'team', 'member', 'deck', 'swap', 'wait'), viewports: ['phone'], probe });
  assert.deepEqual(rows.map(r => [r.case, r.probe]), [['home', true], ['idea', true], ['team', false], ['member', true], ['deck', true], ['swap', true], ['wait', true]]);
});

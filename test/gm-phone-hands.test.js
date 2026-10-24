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
// a tap on the button that reads label, wherever it is on the card
async function tapText(p, send, label) {
  const r = await p.run(`(function () { var n = Array.prototype.find.call(document.querySelectorAll('#bet button, .foot button'), function (b) { return b.textContent === ${JSON.stringify(label)} && b.offsetParent; }); if (!n) return null; var b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  assert.ok(r, `no button reads ${label}`);
  await tapAt(send, r.x, r.y);
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

// The page again with its long waits cut a hundredfold (anything set for 15
// seconds or more), so a give-up the page makes after a minute and a half
// shows in about a second. Only timers that long are touched.
async function quickClock(p, send) {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: '(function () { var st = window.setTimeout; window.setTimeout = function (f, ms) { var rest = Array.prototype.slice.call(arguments, 2); return st.apply(window, [f, ms >= 15000 ? ms / 100 : ms].concat(rest)); }; })()' });
  await send('Page.reload', {});
  await wait(300);
  await p.until("document.readyState === 'complete' && Boolean(document.querySelector('#bet h1')) && !document.body.hasAttribute('data-busy')", 'the page again', 8000);
}

test('browser: a tap whose answer never comes gives up, and the card comes back ready to try again', { skip, timeout: 90000 }, async () => {
  const did = [];
  let answer = false;
  const desk = trace.cardDesk(CARDS.b1, async (action) => {
    did.push(action);
    if (!answer) await new Promise(() => {});
    return { card: CARDS.b2 };
  });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await quickClock(p, send);
    await tapText(p, send, 'not now');
    await wait(400);
    const waiting = await look(p);
    await p.until(`document.querySelector('#bet h1') && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b1.title)} && !document.body.hasAttribute('data-busy') && Boolean(document.querySelector('#bet .act .note').textContent)`, 'the card back', 8000).catch(() => {});
    const gaveUp = await look(p);
    answer = true;
    await tapText(p, send, 'not now');
    await p.until(`document.querySelector('#bet h1') && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b2.title)}`, 'the next card', 8000).catch(() => {});
    return { waiting, gaveUp, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  // while it waits the page is busy, and then it is not
  assert.equal(out.waiting.busy, true, show);
  assert.deepEqual([out.gaveUp.busy, out.gaveUp.has_card, out.gaveUp.title], [false, true, CARDS.b1.title], show);
  assert.equal(out.gaveUp.note, 'that did not reach the mac. try again.', show);
  // the try again goes through
  assert.equal(out.after.title, CARDS.b2.title, show);
  assert.deepEqual(out.did, ['skip', 'skip'], show);
});

// the card on screen reads this title, at rest
const titled = t => `!document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1')) && document.querySelector('#bet h1').textContent === ${JSON.stringify(t)}`;

test('browser: a tap on a card the Mac no longer has, with nothing up there, goes quietly to the big orb instead of looping on the old card', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    // the Mac started again and has nothing on screen
    desk.current = null;
    await tapText(p, send, 'not now');
    await p.until("!document.body.hasAttribute('data-busy') && !document.body.classList.contains('has-card')", 'the big orb', 8000).catch(() => {});
    await wait(700);
    const home = await look(p);
    // a tap on the big orb brings the card the Mac has now
    await p.tap('#orb');
    await p.until(titled(CARDS.b2.title), 'the next card', 8000).catch(() => {});
    return { home, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.home.has_card, out.home.busy, out.home.line], [false, false, 'tap to think'], show);
  assert.equal(out.after.title, CARDS.b2.title, show);
  // the refused tap did nothing; only the big orb asked for a card
  assert.deepEqual(out.did, ['orb'], show);
});

// a job deck card, the kind whose arrows turn it in place
const deckCard = (n = 1) => gmCard.deck({ id: `deck~${n}`, at: 0, total: 2, card: { job_id: 'm1', mission_id: 'm1', member: 'builder', label: 'working', time: 'about 4 hours left', rows: [{ done: 'not yet', work: 'split the big test file', member: 'builder', role: 'builder', status: 'working' }] }, columns: ['done', 'work', 'member', 'role', 'status'], job: { member: 'builder', role: 'builder' } });

test('browser: flipping a deck the Mac has moved past turns to the Mac\'s card with one line why, or to the big orb when nothing is up', { skip, timeout: 120000 }, async () => {
  const runs = [];
  for (const next of [CARDS.b2, null]) {
    const did = [];
    const desk = trace.cardDesk(deckCard(), async (action) => { did.push(action); return { card: deckCard(did.length + 1) }; });
    runs.push(await trace.onPhone(desk, CHROME, async (p, send) => {
      desk.current = next;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      // at once, not on the next look five seconds later
      if (next) await p.until(titled(next.title), 'the Mac card', 2500).catch(() => {});
      else await p.until("!document.body.hasAttribute('data-busy') && !document.body.classList.contains('has-card')", 'the big orb', 8000).catch(() => {});
      await wait(300);
      return { next: next && next.title, did, ...(await look(p)) };
    }));
  }
  const show = JSON.stringify(runs, null, 1);
  const [moved, empty] = runs;
  assert.deepEqual([moved.title, moved.busy, moved.has_card], [CARDS.b2.title, false, true], show);
  assert.equal(moved.note, 'that card changed, so nothing was done. here is the one on screen now', show);
  assert.deepEqual([empty.has_card, empty.busy, empty.line], [false, false, 'tap to think'], show);
  // the refused flips did nothing on the Mac
  assert.deepEqual([moved.did, empty.did], [[], []], show);
});

test('browser: a Mac that errs or is starting again never reads as a dead link, and a page opened then shows its card once the Mac answers', { skip, timeout: 90000 }, async () => {
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
  const read = desk.card;
  let down = true;
  desk.card = () => { if (down) throw new Error('starting again'); return read(); };
  const out = await trace.onPhone(desk, CHROME, async (p) => {
    await wait(1200);
    const during = await look(p);
    down = false;
    // the next look, every five seconds, finds the Mac again
    await p.until(titled(CARDS.b1.title), 'the card', 9000).catch(() => {});
    return { during, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.doesNotMatch(out.during.line, /stopped working/, show);
  assert.equal(out.during.has_card, false, show);
  assert.deepEqual([out.after.has_card, out.after.title], [true, CARDS.b1.title], show);
});

test('browser: when the Mac stops answering, a quiet line in the card says so within about ten seconds, the page asks less often, and the line goes once the Mac answers', { skip, timeout: 90000 }, async () => {
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
  const net = (send, offline) => send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const QUIET = 'the mac is not answering. still trying.';
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    // every look the page makes, on its own clock
    await p.run("(function () { var real = window.fetch; window.__looks = []; window.fetch = function (url, opts) { if (String(url).indexOf('/card') >= 0) window.__looks.push(Date.now()); return real(url, opts); }; })()");
    await send('Network.enable');
    await net(send, true);
    const t0 = Date.now();
    await p.until(`document.querySelector('#bet .act .note').textContent === ${JSON.stringify(QUIET)}`, 'the quiet line', 13000).catch(() => {});
    const down = { after_ms: Date.now() - t0, ...(await look(p)) };
    // sixteen seconds more without the Mac: at every five seconds that would be three looks
    const t1 = Date.now();
    await wait(16000);
    const downLooks = (await p.run('window.__looks')).filter(t => t > t1).length;
    await net(send, false);
    const t2 = Date.now();
    await p.until("document.querySelector('#bet .act .note').textContent === ''", 'the line gone', 17000).catch(() => {});
    return { down, downLooks, cleared_ms: Date.now() - t2, up: await look(p) };
  });
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.down.note, QUIET, show);
  assert.ok(out.down.after_ms <= 12000, show);
  // the card is still the one on screen, and still takes taps
  assert.deepEqual([out.down.title, out.down.busy], [CARDS.b1.title, false], show);
  // while down it asks every fifteen seconds, not every five
  assert.ok(out.downLooks >= 1 && out.downLooks <= 2, show);
  // back online, it looks at once and the line goes
  assert.equal(out.up.note, '', show);
  assert.ok(out.cleared_ms < 2000, show);
});

// the phone's own back button: one step back in the browser's history
async function backButton(send) {
  const h = await send('Page.getNavigationHistory');
  if (h.currentIndex < 1) return false;
  await send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
  return true;
}

test('browser: the back button steps back a card, then to the big orb, and only then leaves the page', { skip, timeout: 90000 }, async () => {
  const team = gmCard.team({ id: 'team~1', rows: [{ member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: the getting started page' }], line: null, deck: false });
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); return { card: action === 'open:team' ? team : CARDS.b1 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await p.tap('#working');
    await p.until(titled('the team'), 'the team', 8000);
    await wait(300);
    await backButton(send);
    await p.until(titled(CARDS.b1.title), 'the first card', 8000).catch(() => {});
    await wait(300);
    const one = await look(p);
    await backButton(send);
    await p.until("!document.body.hasAttribute('data-busy') && !document.body.classList.contains('has-card')", 'the big orb', 8000).catch(() => {});
    await wait(300);
    const two = await look(p);
    const url = await p.run('location.pathname');
    await backButton(send);
    await wait(800);
    const three = await p.run('location.href').catch(() => 'gone');
    return { one, two, url, three, did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.one.has_card, out.one.title], [true, CARDS.b1.title], show);
  assert.deepEqual([out.two.has_card, out.two.busy], [false, false], show);
  assert.equal(out.url, '/', show);
  assert.deepEqual(out.did, ['open:team', 'back'], show);
  // from the big orb the back button leaves, as it always did
  assert.doesNotMatch(out.three, /127\.0\.0\.1/, show);
});

test('browser: back from the lock screen, the page looks at once and shows the card the Mac has now', { skip, timeout: 90000 }, async () => {
  const runs = [];
  for (const how of ['visibilitychange', 'online']) {
    const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
    const read = desk.card;
    const reads = [];
    desk.card = () => { reads.push(Date.now()); return read(); };
    runs.push(await trace.onPhone(desk, CHROME, async (p) => {
      await wait(800);
      desk.current = CARDS.b2;
      const t0 = Date.now();
      await p.run(how === 'online' ? "window.dispatchEvent(new Event('online'))" : "document.dispatchEvent(new Event('visibilitychange'))");
      await p.until(titled(CARDS.b2.title), 'the Mac card', 3000).catch(() => {});
      return { how, looked_ms: reads.filter(t => t >= t0).map(t => t - t0)[0], shown_ms: Date.now() - t0, title: (await look(p)).title };
    }));
  }
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    // the look comes at once, not on the next one five seconds on
    assert.ok(r.looked_ms != null && r.looked_ms < 400, show);
    assert.equal(r.title, CARDS.b2.title, show);
  }
});

test('browser: a card the Mac changed never swaps in under a held finger; the press lands on the card it began on', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const at = await middle(p, "#bet [data-option='skip']");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    desk.current = CARDS.b2;
    // a look comes every five seconds; one passes while the finger is down
    await wait(6200);
    const held = await look(p);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await p.until(titled(CARDS.b2.title), 'the Mac card', 8000).catch(() => {});
    return { held, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.held.title, CARDS.b1.title, show);
  // the release is on the old card, so the Mac refuses it and shows its own
  assert.equal(out.after.title, CARDS.b2.title, show);
  assert.deepEqual(out.did, [], show);
});

test('browser: on the job deck a finger dragging the wide table sideways scrolls it and never flips; a swipe on the card still flips', { skip, timeout: 90000 }, async () => {
  const flips = [];
  const desk = trace.cardDesk(deckCard(), async (action) => { flips.push(action); return { card: deckCard(flips.length + 1) }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const drag = async (x0, y0, x1) => {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= 6; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 6, y: y0 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const g = await p.rect('#bet .grid');
    const scrolls = await p.run("(function () { var g = document.querySelector('#bet .grid'); return g.scrollWidth > g.clientWidth; })()");
    await drag(g.x + g.w - 30, g.y + g.h / 2, g.x + 30);
    await wait(1200);
    const inTable = flips.length;
    const h = await p.rect('#bet h1');
    await drag(h.x + 250, h.y + h.h / 2, h.x + 50);
    await p.until(`${titled('split the big test file')} && document.getElementById('bet').getAttribute('data-card') === 'deck~2'`, 'the flip', 8000).catch(() => {});
    return { scrolls, inTable, flips };
  });
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.scrolls, true, show);
  assert.equal(out.inTable, 0, show);
  assert.deepEqual(out.flips, ['flip'], show);
});

// a team table with one member
const teamOf = (n = 1) => gmCard.team({ id: `team~${n}`, rows: [{ member: 'navigator', role: 'system navigator', ovr: '84', engine: 'tool one m-small', status: 'waiting for your yes', sentence: 'waiting for your yes: plan the pricing page, waiting 2 hours' }], line: null, deck: false });

test('browser: a tap anywhere in the model cell of a team row opens that model\'s swap, not the member\'s talk card', { skip, timeout: 90000 }, async () => {
  const taps = [];
  const desk = trace.cardDesk(teamOf(), async (action, { option }) => { taps.push(option.id); return { card: teamOf(taps.length + 1) }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const td = await p.rect('#bet td.engine');
    const b = await p.rect('#bet td.engine button');
    const engine = await p.run("document.querySelector('#bet td.engine button').getAttribute('data-option')");
    const member = await p.run("document.querySelector('#bet td.member button').getAttribute('data-option')");
    // in the cell, just under the model's words
    await tapAt(send, b.x + b.w / 2, Math.min(td.y + td.h - 3, b.y + b.h + 6));
    await wait(1500);
    return { engine, member, taps, gap: Math.round(td.y + td.h - (b.y + b.h)) };
  }, trace.LAPTOP);
  const show = JSON.stringify(out, null, 1);
  assert.ok(out.gap >= 6, show);
  assert.notEqual(out.engine, out.member, show);
  assert.deepEqual(out.taps, [out.engine], show);
});

test('browser: dragging to select words in a team row selects them and opens nothing; a plain tap on the row still opens it', { skip, timeout: 90000 }, async () => {
  const taps = [];
  const desk = trace.cardDesk(teamOf(), async (action, { option }) => { taps.push(action); return { card: teamOf(taps.length + 1) }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const r = await p.rect('#bet td.status');
    const y = r.y + 14;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x + 10, y, button: 'left', clickCount: 1 });
    for (const dx of [60, 120, 180]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + dx, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 180, y, button: 'left', clickCount: 1 });
    await wait(1200);
    const selected = await p.run('String(window.getSelection())');
    const afterDrag = [...taps];
    // a plain tap on the row, away from the words picked
    const role = await middle(p, '#bet td.role');
    await tapAt(send, role.x, role.y);
    await wait(1500);
    return { selected, afterDrag, taps };
  }, trace.LAPTOP);
  const show = JSON.stringify(out, null, 1);
  assert.ok(out.selected.length > 3, show);
  assert.deepEqual(out.afterDrag, [], show);
  assert.deepEqual(out.taps, ['member'], show);
});

test('browser: a short quiet link like no on a yes card answers a tap 44px wide, and its words stay where they were', { skip, timeout: 90000 }, async () => {
  const taps = [];
  const desk = trace.cardDesk(CARDS.yes, async (action) => { taps.push(action); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const r = await p.rect("#bet [data-option='no']");
    const hits = await p.run(`(function () { var y = ${r.y + r.h / 2}, c = ${r.x + r.w / 2}; return [-21, -16, 16, 21].map(function (dx) { var n = document.elementFromPoint(c + dx, y); return Boolean(n && n.closest && n.closest("[data-option='no']")); }); })()`);
    // a tap 20px left of the middle of the words, outside them
    await tapAt(send, r.x + r.w / 2 - 20, r.y + r.h / 2);
    await wait(1500);
    return { w: r.w, h: r.h, hits, taps };
  });
  const show = JSON.stringify(out, null, 1);
  // the words themselves are narrower than a finger: the button box did not grow
  assert.ok(out.w < 44 && out.h >= 44, show);
  assert.deepEqual(out.hits, [true, true, true, true], show);
  assert.deepEqual(out.taps, ['no'], show);
});

async function press(send, key, code, text) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
}

test('browser: with the keyboard alone, the next card takes the focus on its first action, and going home puts it on the big orb', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.q1, async (action) => { did.push(action); return { card: action === 'orb' ? CARDS.b2 : CARDS.b1 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    // Tab to the first answer and press Enter
    let tabs = 0;
    while ((await look(p)).active !== 'BUTTON:money' && tabs++ < 10) await press(send, 'Tab', 9);
    await press(send, 'Enter', 13, '\r');
    await p.until(titled(CARDS.b1.title), 'the next card', 8000);
    await wait(300);
    const next = await look(p);
    // on to the small orb, and Enter goes home
    tabs = 0;
    while ((await look(p)).active !== 'DIV#lava' && tabs++ < 12) await press(send, 'Tab', 9);
    await press(send, 'Enter', 13, '\r');
    await p.until("!document.body.hasAttribute('data-busy') && !document.body.classList.contains('has-card')", 'the big orb', 8000);
    await wait(300);
    const home = await look(p);
    // Enter on the big orb brings the next card, and the focus goes with it
    await press(send, 'Enter', 13, '\r');
    await p.until(titled(CARDS.b2.title), 'the card after', 8000).catch(() => {});
    await wait(300);
    return { next, home, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.next.active, 'BUTTON:do', show);
  assert.equal(out.home.active, 'CANVAS#orb', show);
  assert.equal(out.after.active, 'BUTTON:do', show);
  assert.deepEqual(out.did, ['answer', 'orb'], show);
});

test('browser: Tab from an open box goes to its send, and Esc in the box puts the focus back on the button it came from', { skip, timeout: 90000 }, async () => {
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const where = () => p.run("(function () { var a = document.activeElement; return { tag: a.tagName, cls: a.className, text: a.textContent, field: Boolean(document.querySelector('#bet .field')) }; })()");
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    const open = await where();
    await press(send, 'Tab', 9);
    await wait(150);
    const tabbed = await where();
    await press(send, 'Tab', 9);
    await wait(150);
    const away = await where();
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    await p.type('take the readme first');
    await press(send, 'Escape', 27);
    await wait(150);
    const escaped = await where();
    return { open, tabbed, away, escaped };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.open.tag, out.open.field], ['INPUT', true], show);
  // Tab moves to send, and the box stays open
  assert.deepEqual([out.tabbed.tag, out.tabbed.cls, out.tabbed.field], ['BUTTON', 'send', true], show);
  // Tab again leaves the empty box, which turns back into its button; the focus goes on
  assert.equal(out.away.field, false, show);
  assert.notEqual(out.away.tag, 'BODY', show);
  // Esc: the words go, the box closes, and its button has the focus
  assert.deepEqual([out.escaped.tag, out.escaped.text, out.escaped.field], ['BUTTON', 'or say something', false], show);
});

test('browser: Enter while a word is still being composed on a Japanese or Chinese keyboard is left to the keyboard and sends nothing', { skip, timeout: 90000 }, async () => {
  const said = [];
  const desk = trace.cardDesk(CARDS.b1, async (a, { text, card }) => { said.push(text); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    await send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    // the Enter that picks the word, while it is still being composed
    await p.run("document.querySelector('#bet .field input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }))");
    await wait(600);
    const composing = { said: [...said], ...(await look(p)) };
    await send('Input.insertText', { text: 'にほん' });
    await p.run("document.querySelector('#bet .field input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))");
    await p.until(titled(CARDS.b2.title), 'the next card', 8000).catch(() => {});
    return { composing, said };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual(out.composing.said, [], show);
  assert.deepEqual([out.composing.field, out.composing.title], [true, CARDS.b1.title], show);
  // the Enter after the word is picked sends it
  assert.equal(out.said.length, 1, show);
});

test('browser: Esc on an armed do it steps back to do it at once, and the next tap arms it again rather than starting it', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await tapText(p, send, 'do it');
    await wait(150);
    const armed = await look(p);
    await press(send, 'Escape', 27);
    await wait(150);
    const esc = await look(p);
    const label = await p.run("document.querySelector('#bet .pill').textContent");
    // a tap after Esc arms it again rather than starting it
    await wait(500);
    await tapText(p, send, 'do it');
    await wait(300);
    return { armed: armed.armed, esc: esc.armed, label, again: (await look(p)).armed, did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual(out.armed, ['tap again to start'], show);
  assert.deepEqual([out.esc, out.label], [[], 'do it'], show);
  assert.deepEqual([out.again, out.did], [['tap again to start'], []], show);
});

test('browser: send is dim while its box is empty and lights up with the first word, also for words put back after a failed send', { skip, timeout: 90000 }, async () => {
  let fail = true;
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => { if (fail) { fail = false; return { ok: false, reason: 'steer_failed', message: 'it did not reach them. try again in a minute.' }; } return { card }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    const dim = () => p.run("Number(getComputedStyle(document.querySelector('#bet .field .send')).opacity)");
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    const empty = await dim();
    await p.type('take the readme first');
    const typed = await dim();
    await press(send, 'Enter', 13, '\r');
    await p.until(`${titled(CARDS.b1.title)} && Boolean(document.querySelector('#bet .field input')) && document.querySelector('#bet .field input').value === 'take the readme first'`, 'the words back', 8000);
    await wait(200);
    return { empty, typed, back: await dim() };
  });
  const show = JSON.stringify(out, null, 1);
  assert.ok(out.empty < 0.6, show);
  assert.equal(out.typed, 1, show);
  assert.equal(out.back, 1, show);
});

test('browser: a tap shows no system flash box, a double tap never zooms, and a long press on a button selects nothing, while card words stay selectable', { skip, timeout: 90000 }, async () => {
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
  const out = await trace.onPhone(desk, CHROME, async (p) => p.run(`(function () {
    var cs = function (sel) { return getComputedStyle(document.querySelector(sel)); };
    return {
      touch: cs('html').touchAction,
      flash: [cs('#bet .pill').webkitTapHighlightColor, cs('#working').webkitTapHighlightColor, cs('#bet .links button').webkitTapHighlightColor],
      buttons: [cs('#bet .pill').userSelect, cs('#bet .links button').userSelect, cs('#lava').userSelect, cs('#orb').userSelect],
      words: [cs('#bet h1').userSelect, cs('#bet .why').userSelect],
    };
  })()`));
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.touch, 'manipulation', show);
  assert.deepEqual(out.flash, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], show);
  assert.deepEqual(out.buttons, ['none', 'none', 'none', 'none'], show);
  assert.deepEqual(out.words, ['auto', 'auto'], show);
  // iPhone's long-press menu is off on the same things
  const { phonePage } = require('../lib/gm-phone-page');
  assert.match(phonePage('N'), /button, \.lava, \.stage canvas \{ -webkit-touch-callout: none;/);
});

test('browser: while the sphere waits on a slow answer its line never says tap to think, and past eight seconds it says the Mac is still at it', { skip, timeout: 120000 }, async () => {
  const runs = [];
  for (const from of ['card', 'big orb']) {
    const desk = trace.cardDesk(from === 'card' ? CARDS.b1 : null, async () => { await wait(10500); return { card: CARDS.b2 }; });
    runs.push(await trace.onPhone(desk, CHROME, async (p, send) => {
      if (from === 'card') await tapText(p, send, 'not now');
      else { await p.until("document.getElementById('line').textContent === 'tap to think'", 'the big orb', 8000); await p.tap('#orb'); }
      await wait(1500);
      const soon = await look(p);
      await wait(7500);
      const late = await look(p);
      await p.until(titled(CARDS.b2.title), 'the card', 8000).catch(() => {});
      return { from, soon, late, after: await look(p) };
    }, trace.PHONE, { firstCard: from === 'card' }));
  }
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    assert.deepEqual([r.soon.has_card, r.soon.busy, r.soon.line], [false, true, ''], show);
    assert.equal(r.late.line, 'still waiting on the mac', show);
    assert.equal(r.after.title, CARDS.b2.title, show);
  }
});

test('browser: a note on the calm line that takes a while reads sending in place of send until the Mac has it', { skip, timeout: 90000 }, async () => {
  const calm = gmCard.wait({ id: 'wait:7' });
  const notes = [];
  const desk = trace.cardDesk(calm, async (a, { card, text }) => { notes.push(text); await wait(2200); return { card }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await p.until("document.body.classList.contains('waiting') && Boolean(document.querySelector('#bet .sayline .field.stay input'))", 'the calm line', 8000);
    await wait(900);
    await p.tap('#bet .sayline .field.stay input');
    await p.type('make it about schools');
    await press(send, 'Enter', 13, '\r');
    const spot = () => p.run("(function () { var g = document.querySelector('#bet .sayline .field .send'); return { text: g.textContent, shown: getComputedStyle(g).visibility === 'visible', words: document.querySelector('#bet .sayline .field input').value }; })()");
    await wait(250);
    const quick = await spot();
    await wait(800);
    const slow = await spot();
    await p.until("document.querySelector('#bet .sayline .field input').value === ''", 'the box cleared', 6000).catch(() => {});
    return { quick, slow, done: await spot(), notes };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  // a quick answer never flickers a word: the first moment is the plain held look
  assert.equal(out.quick.shown, false, show);
  assert.deepEqual([out.slow.text, out.slow.shown, out.slow.words], ['sending', true, 'make it about schools'], show);
  assert.deepEqual([out.done.text, out.done.words], ['send', ''], show);
  assert.deepEqual(out.notes, ['make it about schools'], show);
});

test('browser: when the phone keyboard leaves only a strip of screen, the box being typed in comes back into view', { skip, timeout: 90000 }, async () => {
  const small = { width: 320, height: 568, deviceScaleFactor: 2, mobile: true };
  const desk = trace.cardDesk(CARDS.b1, async (a, { card }) => ({ card }));
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await p.tap('#bet .sayline .quiet');
    await wait(200);
    const where = () => p.run("(function () { var r = document.querySelector('#bet .field').getBoundingClientRect(); var vv = window.visualViewport; return { top: Math.round(r.top), bottom: Math.round(r.bottom), shows: Math.round(vv.offsetTop + vv.height), typing: document.activeElement === document.querySelector('#bet .field input') }; })()");
    const before = await where();
    // the keyboard takes the bottom of the screen
    await send('Emulation.setDeviceMetricsOverride', { ...small, height: 300 });
    await wait(600);
    return { before, after: await where() };
  }, small);
  const show = JSON.stringify(out, null, 1);
  // the box sat below what the keyboard leaves showing
  assert.ok(out.before.bottom > 300, show);
  assert.ok(out.after.top >= 0 && out.after.bottom <= out.after.shows, show);
  assert.equal(out.after.typing, true, show);
});

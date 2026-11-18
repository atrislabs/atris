'use strict';

// Card recovery, navigation and reconnects on the real phone page in Chrome.

const test = require('node:test');
const assert = require('node:assert/strict');

const trace = require('../scripts/gm-phone-trace');
const gmCard = require('../lib/gm-card');
const { wait, look, tapAt, tapText, middle, quickClock, titled, deckCard } = require('./helpers/gm-phone-hands');

const CHROME = trace.findChrome();
const { CARDS } = trace;
const skip = !CHROME && 'no chrome on this machine';

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

test('browser: a do it whose two steps on the Mac outlast the give-up is never called a failure, a retry meanwhile does not start it twice, and the result shows when it is done', { skip, timeout: 90000 }, async () => {
  const did = [];
  // confirming do it on the Mac: two steps, each slower than the page waits for both
  const desk = trace.cardDesk(CARDS.b1, async (action) => {
    did.push(action);
    await wait(1600);
    await wait(1600);
    return { card: CARDS.b2, ack: 'builder has it and is starting now.' };
  });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    // the page's give-up of a minute and a half comes after about a second here
    await quickClock(p, send);
    const t0 = Date.now();
    await tapText(p, send, 'do it');
    await wait(450);
    await tapText(p, send, 'tap again to start');
    await p.until(`${titled(CARDS.b1.title)} && Boolean(document.querySelector('#bet .act .note').textContent)`, 'the card back', 8000);
    const gaveUp = { at_ms: Date.now() - t0, ...(await look(p)) };
    // the owner tries again while the Mac is still at it
    await tapText(p, send, 'do it');
    await wait(450);
    await tapText(p, send, 'tap again to start');
    await p.until(titled(CARDS.b2.title), 'the result', 10000).catch(() => {});
    return { gaveUp, done_ms: Date.now() - t0, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  // the page let go before the Mac was done, and said what is true
  assert.ok(out.gaveUp.at_ms < 3200, show);
  assert.equal(out.gaveUp.note, 'the mac is still working on it. you will see the result here once it is done.', show);
  assert.doesNotMatch(JSON.stringify(out.gaveUp), /did not (reach|go through)/, show);
  assert.equal(out.gaveUp.busy, false, show);
  // one start on the Mac, however many taps, and its result on screen
  assert.deepEqual(out.did, ['do'], show);
  assert.equal(out.after.title, CARDS.b2.title, show);
});

test('browser: a slow do it with no retry still shows its result by itself once the Mac is done', { skip, timeout: 90000 }, async () => {
  const did = [];
  const desk = trace.cardDesk(CARDS.b1, async (action) => { did.push(action); await wait(1600); await wait(1600); return { card: CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await quickClock(p, send);
    await tapText(p, send, 'do it');
    await wait(450);
    await tapText(p, send, 'tap again to start');
    await p.until(`${titled(CARDS.b1.title)} && Boolean(document.querySelector('#bet .act .note').textContent)`, 'the card back', 8000);
    const gaveUp = await look(p);
    await p.until(titled(CARDS.b2.title), 'the result', 8000).catch(() => {});
    return { gaveUp, after: await look(p), did };
  });
  const show = JSON.stringify(out, null, 1);
  assert.match(out.gaveUp.note, /still working on it/, show);
  assert.deepEqual([out.after.title, out.did], [CARDS.b2.title, ['do']], show);
});

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
  assert.equal(moved.note, 'that card changed, so nothing was done. here is the one on screen now.', show);
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

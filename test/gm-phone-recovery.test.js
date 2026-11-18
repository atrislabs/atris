'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const trace = require('../scripts/gm-phone-trace');
const gmCard = require('../lib/gm-card');
const { wait, look, tapText, quickClock, titled, deckCard, teamOf } = require('../scripts/gm-phone-hands-fixture');

const CHROME = trace.findChrome();
const { CARDS } = trace;
const skip = !CHROME && 'no chrome on this machine';

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

// The calm line's ask that brings a queued idea in, the first one hung for
// good, as a post on a dead link never answers; every reveal is recorded with
// the id it carries.
const HANG_FIRST_REVEAL = `(function () {
  var real = window.fetch;
  window.__reveals = [];
  window.fetch = function (url, opts) {
    var b = null;
    try { b = opts && opts.method === 'POST' && opts.body ? JSON.parse(opts.body) : null; } catch (e) { b = null; }
    if (String(url).indexOf('/act') >= 0 && b && b.orb) {
      window.__reveals.push(b.send || null);
      if (window.__reveals.length === 1) return new Promise(function () {});
    }
    return real.apply(this, arguments);
  };
})()`;

test('browser: on the calm line a reveal that never answers is given up on, the next one goes with the same id, and the queued idea lands', { skip, timeout: 90000 }, async () => {
  const did = [];
  let desk = null;
  desk = trace.cardDesk(CARDS.calm, async (action) => { did.push(action); return { card: CARDS.b1 }; }, { queue: () => (desk.current && desk.current.kind === 'wait' ? 1 : 0) });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HANG_FIRST_REVEAL });
    await quickClock(p, send);
    await p.until(titled(CARDS.b1.title), 'the idea', 15000).catch(() => {});
    return { reveals: await p.run('window.__reveals'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.after.has_card, out.after.title], [true, CARDS.b1.title], show);
  // a second reveal went out, with the id of the one the page gave up on, so the Mac answers it once
  assert.ok(out.reveals.length >= 2 && out.reveals[0] && out.reveals[1] === out.reveals[0], show);
  assert.deepEqual(out.did, ['orb'], show);
});

// The big orb's tap on a page with no card: the first reaches the Mac, which
// makes its card, but the answer never gets back; every tap is recorded with
// the id it carries.
const LOSE_FIRST_ORB_ANSWER = `(function () {
  var real = window.fetch;
  window.__orbTaps = [];
  window.fetch = function (url, opts) {
    var b = null;
    try { b = opts && opts.method === 'POST' && opts.body ? JSON.parse(opts.body) : null; } catch (e) { b = null; }
    if (String(url).indexOf('/act') >= 0 && b && b.orb && b.card_id == null) {
      window.__orbTaps.push(b.send || null);
      if (window.__orbTaps.length === 1) { real.apply(this, arguments); return new Promise(function () {}); }
    }
    return real.apply(this, arguments);
  };
})()`;

test('browser: a big orb tap tried again while the first one\'s answer is lost shows the first tap\'s card, and the Mac makes no other', { skip, timeout: 90000 }, async () => {
  const did = [];
  const next = [CARDS.b1, CARDS.b2];
  const desk = trace.cardDesk(null, async (action) => { did.push(action); return { card: next[did.length - 1] || CARDS.b2 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: LOSE_FIRST_ORB_ANSWER });
    await quickClock(p, send, "document.getElementById('line').textContent === 'tap to think'");
    await p.tap('#orb');
    // the page stops waiting on the first answer and says the Mac is still at it
    await p.until("document.getElementById('line').textContent.indexOf('still working') >= 0 && !document.body.hasAttribute('data-busy')", 'the page stops waiting', 8000).catch(() => {});
    const gaveUp = await look(p);
    await p.tap('#orb');
    await p.until("document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1')) && !document.body.hasAttribute('data-busy')", 'a card', 10000).catch(() => {});
    await wait(300);
    return { gaveUp, taps: await p.run('window.__orbTaps'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.match(out.gaveUp.line, /still working/, show);
  // the owner sees the card the first tap made, and nothing was passed on the Mac
  assert.deepEqual([out.after.has_card, out.after.title], [true, CARDS.b1.title], show);
  assert.deepEqual(out.did, ['orb'], show);
  // the second tap carried the first tap's id, so the Mac answered it with the first tap's card
  assert.ok(out.taps.length === 2 && out.taps[0] && out.taps[1] === out.taps[0], show);
});

// ---- the big orb's tap id lives until a card lands ----------------------------------

// every big orb tap, recorded with the id it carries;
// `first` is what happens to the first tap after it reaches the Mac (or not)
const ORB_TAPS = first => `(function () {
  var real = window.fetch;
  window.__orbTaps = [];
  window.fetch = function (url, opts) {
    var b = null;
    try { b = opts && opts.method === 'POST' && opts.body ? JSON.parse(opts.body) : null; } catch (e) { b = null; }
    if (String(url).indexOf('/act') >= 0 && b && b.orb) {
      window.__orbTaps.push(b.send || null);
      var n = window.__orbTaps.length;
      ${first}
    }
    return real.apply(this, arguments);
  };
})()`;
const orbDesk = (did) => trace.cardDesk(null, async (action) => { did.push(action); return { card: [CARDS.b1, CARDS.b2][did.length - 1] || CARDS.b2 }; });
const atRestOnCard = "document.body.classList.contains('has-card') && Boolean(document.querySelector('#bet h1')) && !document.body.hasAttribute('data-busy')";
const onBigOrb = "!document.body.classList.contains('has-card') && !document.body.hasAttribute('data-busy') && document.getElementById('line').textContent === 'tap to think'";

test('browser: a big orb tap whose answer is cut off mid-read keeps its id, so the retry shows the card the Mac made', { skip, timeout: 90000 }, async () => {
  const did = [];
  // the first tap reaches the Mac; its answer starts and the link drops mid-read
  const cut = "if (n === 1) return real.apply(this, arguments).then(function (r) { var body = new ReadableStream({ start: function (c) { c.enqueue(new TextEncoder().encode('{\"ok\":true,')); c.error(new TypeError('the link dropped')); } }); return new Response(body, { status: r.status, headers: { 'content-type': 'application/json' } }); });";
  const out = await trace.onPhone(orbDesk(did), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ORB_TAPS(cut) });
    await quickClock(p, send, "document.getElementById('line').textContent === 'tap to think'");
    await p.tap('#orb');
    await p.until("document.getElementById('line').textContent.indexOf('did not go through') >= 0 && !document.body.hasAttribute('data-busy')", 'the line why', 8000).catch(() => {});
    await p.tap('#orb');
    await p.until(atRestOnCard, 'a card', 10000).catch(() => {});
    return { taps: await p.run('window.__orbTaps'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.after.has_card, out.after.title, out.did], [true, CARDS.b1.title, ['orb']], show);
  assert.ok(out.taps.length === 2 && out.taps[0] && out.taps[1] === out.taps[0], show);
});

test('browser: a big orb tap\'s late answer that lands while its retry is out never frees the id, so the next tap still shows the first card', { skip, timeout: 90000 }, async () => {
  const did = [];
  // the first tap reaches the Mac and its answer is held; the retry never reaches it
  const held = "if (n === 1) { var got = real.apply(this, arguments); return new Promise(function (resolve, reject) { window.__release = function () { got.then(resolve, reject); }; }); } if (n === 2) return new Promise(function () {});";
  const out = await trace.onPhone(orbDesk(did), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ORB_TAPS(held) });
    await quickClock(p, send, "document.getElementById('line').textContent === 'tap to think'");
    const gaveUp = "document.getElementById('line').textContent.indexOf('still working') >= 0 && !document.body.hasAttribute('data-busy')";
    await p.tap('#orb');
    await p.until(gaveUp, 'the page stops waiting', 8000).catch(() => {});
    await p.tap('#orb');
    await p.until("document.body.hasAttribute('data-busy')", 'the retry out', 3000).catch(() => {});
    // the first answer comes while the retry is still out
    await p.run('window.__release()');
    await wait(100);
    await p.until(gaveUp, 'the page stops waiting on the retry', 8000).catch(() => {});
    await p.tap('#orb');
    await p.until(atRestOnCard, 'a card', 10000).catch(() => {});
    return { taps: await p.run('window.__orbTaps'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.after.has_card, out.after.title, out.did], [true, CARDS.b1.title, ['orb']], show);
  assert.ok(out.taps.length === 3 && out.taps[0] && out.taps[1] === out.taps[0] && out.taps[2] === out.taps[0], show);
});

test('browser: a big orb tap whose card a look brought in frees its id, so the next real tap brings the next card', { skip, timeout: 90000 }, async () => {
  const did = [];
  const { phonePage } = require('../lib/gm-phone-page');
  // the page's first look gets nothing; the first tap reaches the Mac and its answer hangs
  const hang = "if (n === 1) { real.apply(this, arguments); return new Promise(function () {}); }";
  const firstLookFails = `(function () { var real = window.fetch, looks = 0; window.fetch = function (url, opts) { if (String(url).indexOf('/card') >= 0 && !(opts && opts.method === 'POST') && looks++ === 0) return Promise.reject(new TypeError('the Mac is away')); return real.apply(this, arguments); }; })()`;
  const out = await trace.onPhone(orbDesk(did), CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ORB_TAPS(hang) });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: firstLookFails });
    await quickClock(p, send, "!document.body.classList.contains('opening') && document.getElementById('line').textContent === 'tap to think'");
    await p.tap('#orb');
    // a look brings the card the first tap made, then the owner goes home with the small orb
    await p.until(`${atRestOnCard} && document.querySelector('#bet h1').textContent === ${JSON.stringify(CARDS.b1.title)}`, 'the card from a look', 12000).catch(() => {});
    const fromLook = await look(p);
    await p.tap('#lava');
    await p.until(onBigOrb, 'the big orb', 8000).catch(() => {});
    await p.tap('#orb');
    await p.until(`${atRestOnCard} && document.querySelector('#bet h1').textContent !== ${JSON.stringify(CARDS.b1.title)}`, 'the next card', 10000).catch(() => {});
    return { fromLook, taps: await p.run('window.__orbTaps'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false, page: nonce => phonePage(nonce, null) });
  const show = JSON.stringify(out, null, 1);
  assert.equal(out.fromLook.title, CARDS.b1.title, show);
  assert.deepEqual([out.after.has_card, out.after.title, out.did], [true, CARDS.b2.title, ['orb', 'orb']], show);
  assert.ok(out.taps.length === 2 && out.taps[0] && out.taps[1] !== out.taps[0], show);
});

test('browser: a big orb tap the Mac answers with nothing to show frees its id, so the next tap brings the card that is ready by then', { skip, timeout: 90000 }, async () => {
  const did = [];
  // the first tap: the Mac has nothing to show yet; by the second, a card is ready
  const desk = trace.cardDesk(null, async (action) => { did.push(action); return { card: did.length === 1 ? null : CARDS.b1 }; });
  const out = await trace.onPhone(desk, CHROME, async (p, send) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ORB_TAPS('') });
    await send('Page.reload', {});
    await p.until(`document.readyState === 'complete' && ${onBigOrb}`, 'the big orb', 8000);
    await p.tap('#orb');
    await wait(400);
    await p.until(onBigOrb, 'the big orb again', 8000).catch(() => {});
    await p.tap('#orb');
    await p.until(atRestOnCard, 'the card', 10000).catch(() => {});
    return { taps: await p.run('window.__orbTaps'), did, after: await look(p) };
  }, trace.PHONE, { firstCard: false });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.after.has_card, out.after.title, out.did], [true, CARDS.b1.title, ['orb', 'orb']], show);
  assert.ok(out.taps.length === 2 && out.taps[1] !== out.taps[0], show);
});

// the cards the owner opens from the footer: they sit over the Mac's card and
// never stand for what a big orb tap made
const onKind = kind => `document.body.classList.contains('has-card') && !document.body.hasAttribute('data-busy') && document.getElementById('bet').getAttribute('data-kind') === ${JSON.stringify(kind)} && document.getElementById('bet').classList.contains('up')`;

test('browser: a big orb tap whose idea never reached the page keeps its id through the team, the job deck, and a talk card, so the next tap shows that idea', { skip, timeout: 180000, concurrency: 2 }, async t => {
  const routes = {
    // the team from the footer, then closed back to the big orb
    team: async (p, send) => { await p.tap('#working'); await p.until(onKind('team'), 'the team', 8000); await tapText(p, send, 'close'); },
    // the job deck from the footer, back to the team, then closed
    deck: async (p, send) => { await p.tap('#needs'); await p.until(onKind('deck'), 'the deck', 8000); await tapText(p, send, 'back to the team'); await p.until(onKind('team'), 'the team', 8000); await tapText(p, send, 'close'); },
    // the team, a member's talk card, back to the team, then closed
    talk: async (p, send) => { await p.tap('#working'); await p.until(onKind('team'), 'the team', 8000); await tapText(p, send, 'navigator'); await p.until(onKind('member'), 'the talk card', 8000); await tapText(p, send, 'back to the team'); await p.until(onKind('team'), 'the team', 8000); await tapText(p, send, 'close'); },
  };
  await Promise.all(Object.entries(routes).map(([name, route]) => t.test(name, async () => {
    const did = [];
    let ideas = 0;
    // the Mac's own card under the team stays the idea the first tap made
    const desk = trace.cardDesk(null, async (action, { card }) => {
      did.push(action);
      if (action === 'orb') { ideas += 1; return { card: [CARDS.b1, CARDS.b2][ideas - 1] || CARDS.b2 }; }
      if (action === 'open:team') return { card: teamOf(1) };
      if (action === 'open:deck') return { card: deckCard(1) };
      if (action === 'member') return { card: gmCard.member({ id: 'member~1', name: 'navigator', sentence: 'waiting for your yes: plan the pricing page.' }) };
      if (action === 'back') return { card: card && card.kind === 'team' ? CARDS.b1 : teamOf(2) };
      return { card };
    }, { needs: () => 1 });
    // the first tap reaches the Mac, which makes its idea, and the answer never comes back
    const hang = "if (n === 1) { real.apply(this, arguments); return new Promise(function () {}); }";
    const r = await trace.onPhone(desk, CHROME, async (p, send) => {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: ORB_TAPS(hang) });
      await quickClock(p, send, "document.getElementById('line').textContent === 'tap to think'");
      await p.tap('#orb');
      await p.until("document.getElementById('line').textContent.indexOf('still working') >= 0 && !document.body.hasAttribute('data-busy')", 'the page stops waiting', 8000);
      await route(p, send);
      await p.until(onBigOrb, 'the big orb', 8000).catch(() => {});
      await p.tap('#orb');
      await p.until(atRestOnCard, 'a card', 10000).catch(() => {});
      return { taps: await p.run('window.__orbTaps'), orbs: did.filter(a => a === 'orb').length, after: await look(p) };
    }, trace.PHONE, { firstCard: false });
    const show = JSON.stringify(r, null, 1);
    // the owner sees the idea the first tap made, and the Mac made no other
    assert.deepEqual([name, r.after.has_card, r.after.title, r.orbs], [name, true, CARDS.b1.title, 1], show);
    assert.ok(r.taps.length === 2 && r.taps[0] && r.taps[1] === r.taps[0], `${name}: ${show}`);
  })));
});

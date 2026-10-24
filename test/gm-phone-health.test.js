'use strict';

// The phone page's health: how it opens, how it reads to a screen reader and
// at 200% zoom, how it holds up over a long session, and what it does when
// the Mac sleeps or the server stops. The browser tests drive the real page
// in headless Chrome (scripts/gm-phone-health.js) and skip without Chrome.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const phone = require('../lib/gm-phone');
const gmCard = require('../lib/gm-card');
const { phonePage } = require('../lib/gm-phone-page');
const trace = require('../scripts/gm-phone-trace');
const health = require('../scripts/gm-phone-health');

const TOKEN = 'h'.repeat(43);
const CHROME = trace.findChrome();
const browser = { skip: !CHROME && 'no chrome on this machine', timeout: 180000 };

// the real phone handler over http with a desk that serves one card
async function serveDesk(desk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-health-'));
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: dir, token: TOKEN, hosts, loadView: () => ({}), runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true, snapshotTarget: () => () => true, logPath: path.join(dir, 'log.jsonl'), page: phonePage, makeBetDesk: () => desk,
  });
  const server = http.createServer((q, s) => { handler(q, s).catch(() => { s.writeHead(500); s.end(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  return {
    get: async (p) => { const r = await fetch(`http://${base}${p}${p.includes('?') ? '&' : '?'}t=${TOKEN}`); return { status: r.status, headers: r.headers, text: await r.text() }; },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

// ---- first paint ------------------------------------------------------------------

test('over http: the page carries the card on screen, so it paints that card first; words that look like markup stay words', async () => {
  const card = gmCard.idea({ id: 'bet-x', title: 'Ship the </script><b>page</b> today', body: 'more people try it by nov 1.' });
  const s = await serveDesk(trace.cardDesk(card, async () => ({ card })));
  try {
    const page = await s.get('/');
    assert.equal(page.status, 200);
    const held = page.text.match(/<script type="application\/json" id="first-look">([^<]*)<\/script>/);
    assert.ok(held, 'the first look sits in the page as data');
    const first = JSON.parse(held[1]);
    assert.equal(first.card.id, 'bet-x');
    assert.equal(first.card.title, card.title);
    assert.deepEqual(first, JSON.parse((await s.get('/card')).text), 'the same answer GET /card gives');
    assert.ok(!page.text.includes('</script><b>'), 'a title can never close the script it sits in');
  } finally {
    await s.close();
  }
  // no desk, no card: the data block is empty and the page asks once
  assert.match(phonePage('n'), /<script type="application\/json" id="first-look"><\/script>/);
});

test('browser: a card already up on the Mac is the first thing painted, with no big orb before it and no layout shift; with none the dots are on the first frame', browser, async () => {
  for (const cpu of [1, 4]) {
    const withCard = await health.firstPaintTrace({ chromePath: CHROME, cpu });
    const show = JSON.stringify(withCard);
    assert.equal(withCard.first_frame && withCard.first_frame.card, true, show);
    assert.equal(withCard.first_frame.title, trace.CARDS.b1.title, show);
    assert.equal(withCard.orb_frames_before_card, 0, show);
    assert.equal(withCard.layout_shift, 0, show);
    assert.deepEqual(withCard.console, [], show);
    const none = await health.firstPaintTrace({ chromePath: CHROME, card: null, cpu });
    assert.equal(none.first_frame && none.first_frame.dots, true, JSON.stringify(none));
    assert.equal(none.first_frame.card, false, JSON.stringify(none));
    assert.deepEqual(none.console, [], JSON.stringify(none));
  }
});

// ---- the Mac asleep -------------------------------------------------------------------

test('browser: while the Mac sleeps the page has one ask for the card out at a time, under a card and on the calm line; a tap still reaches it, and on waking the page goes on', browser, async () => {
  const out = await health.asleepTrace({ chromePath: CHROME, asleepMs: 16000, calmMs: 6000 });
  const show = JSON.stringify(out);
  assert.equal(out.card_asks_out, 1, show);
  assert.equal(out.calm_card_asks_most, 1, show);
  assert.equal(out.tap_reached_mac, true, show);
  assert.equal(out.next_card, trace.CARDS.b2.title, show);
  assert.deepEqual(out.console, [], show);
});

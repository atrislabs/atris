'use strict';

// atris nexus rank / window / decides, with every backend call faked.
// Only made-up people and lists appear here; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand, USAGE } = require('../commands/nexus');
const { daysWords, host } = require('../commands/nexus-rank');

const LIST = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const RAE = '11111111-0000-4000-8000-00000000000a';
const BO = '22222222-0000-4000-8000-00000000000b';
const CY = '33333333-0000-4000-8000-00000000000c';
const DEE = '44444444-0000-4000-8000-00000000000d';
const EVE = '55555555-0000-4000-8000-00000000000e';
const NOW = new Date('2026-11-23T09:00:00Z');
const PERSON = {};
const HELPER = { CLAUDECODE: '1', ATRIS_MEMBER: 'scout' };

const LISTS = [
  { id: LIST, name: 'Texas studios filling a January training', count: 5 },
  { id: OTHER, name: 'Utah studios', count: 0 },
];

const ROWS = [
  {
    person_id: RAE, name: 'Rae Sample', title: 'Owner', company: 'Rae Studio', city: 'Austin', tier: 'S',
    tier_why: 'Owner decides alone and the window closes this week.',
    why_now: { line: 'Posted a January training with 3 seats left', source_url: 'https://www.raestudio.example/news' },
    window: { ends_on: '2026-11-27', days_left: 4 },
    decider: { line: 'Rae, the owner', source_url: 'https://raestudio.example/about' },
    email: { check: 'own_site' }, way_in: { kind: 'intro', through: ['Bo Example'] },
    stage: 'reached', replied_waiting: false, missing: [],
  },
  {
    person_id: BO, name: 'Bo Example', title: 'Director', company: 'Bo Dance', city: 'Dallas', tier: 'A',
    tier_why: 'Replied last week.', why_now: { line: 'Hiring a front desk', source_url: 'not a link' },
    window: { ends_on: '2026-11-23', days_left: 0 }, decider: null,
    email: { check: 'secondhand' }, way_in: { kind: 'first', through: [] },
    stage: 'replied', replied_waiting: true, missing: ['decider'],
  },
  {
    person_id: CY, name: 'Cy Person', title: null, company: 'Cy Yoga', city: null, tier: 'B',
    tier_why: 'Fits, no deadline seen.', why_now: null,
    window: { ends_on: '2026-11-20', days_left: -3 }, decider: null,
    email: { check: 'unchecked' }, way_in: { kind: 'cold', through: [] },
    stage: 'found', replied_waiting: false, missing: ['why_now', 'decider', 'email_check'],
  },
  {
    person_id: DEE, name: 'Dee Tester', title: 'Owner', company: null, city: 'Houston', tier: null,
    tier_why: '', why_now: null, window: null, decider: null,
    email: { check: 'none' }, way_in: { kind: 'cold', through: [] },
    stage: 'found', replied_waiting: false, missing: ['why_now', 'window', 'decider', 'email_check'],
  },
  {
    person_id: EVE, name: 'Eve Made', title: null, company: null, city: null, tier: null,
    tier_why: '', why_now: null, window: { ends_on: '2026-11-24', days_left: 1 }, decider: null,
    email: { check: 'none' }, way_in: { kind: 'cold', through: [] },
    stage: 'found', replied_waiting: false, missing: ['why_now', 'decider', 'email_check'],
  },
];

const RANKED = {
  list: { id: LIST, name: 'Texas studios filling a January training', people: 5 },
  as_of: '2026-11-23',
  counts: { S: 1, A: 1, B: 1, none: 2 },
  rows: ROWS,
};

/** A fake Nexus. `over` replaces an answer by "METHOD /path". */
function backend(over = {}, people = []) {
  const state = { calls: [], people };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    const url = new URL(pathname, 'https://x.test');
    state.calls.push({ method, url: pathname, path: url.pathname, body: options.body });
    const key = `${method} ${url.pathname}`;
    if (over[key]) return typeof over[key] === 'function' ? over[key](options) : over[key];
    if (key === 'GET /nexus/lists') return answer(200, { lists: LISTS });
    if (key === `GET /nexus/lists/${LIST}/ranked`) return answer(200, RANKED);
    if (key === 'POST /nexus/people/search') {
      const q = String(options.body.q || '').toLowerCase();
      const hits = state.people.filter((p) => p.name.toLowerCase().includes(q));
      return answer(200, { people: hits, total: hits.length });
    }
    const m = /^\/nexus\/people\/([^/]+)\/mine$/.exec(url.pathname);
    if (method === 'PATCH' && m) {
      const p = state.people.find((x) => x.id === m[1]);
      const extra = { ...p.private.extra };
      for (const [k, v] of Object.entries(options.body.extra || {})) {
        if (v === null) delete extra[k]; else extra[k] = v;
      }
      p.private = { ...p.private, extra };
      return answer(200, { card: p });
    }
    return answer(404, { detail: 'Not Found' });
  };
  return { request, state };
}

function card(id, name, extra = {}) {
  return { id, mine: true, name, company_name: null, location_raw: null, private: { stage: 'found', closeness: 1, extra } };
}

async function run(args, server, env = PERSON, now = NOW) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => now, env,
    getToken: async () => ({ token: 't' }), apiRequestJson: server.request,
    client: () => ({ read: async () => { throw new Error('the saved list is never read'); }, write: async () => { throw new Error('never written'); } }),
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

const writes = (server) => server.state.calls.filter((c) => c.method !== 'GET' && c.path !== '/nexus/people/search');

test('days left in plain words', () => {
  assert.equal(daysWords({ days_left: 4 }), '4 days left');
  assert.equal(daysWords({ days_left: 1 }), '1 day left');
  assert.equal(daysWords({ days_left: 0 }), 'closes today');
  assert.equal(daysWords({ days_left: -1 }), 'window closed 1 day ago');
  assert.equal(daysWords({ days_left: -3 }), 'window closed 3 days ago');
  assert.equal(daysWords(null), 'no date');
  assert.equal(daysWords({ ends_on: null, days_left: null }), 'no date');
  assert.equal(host('https://www.raestudio.example/news'), 'raestudio.example');
  assert.equal(host('not a link'), '');
});

test('the three words are in the help and never fall through to a person search', async () => {
  for (const word of ['rank', 'window', 'decides']) assert.match(USAGE, new RegExp(`atris nexus ${word}\\b`), `help names ${word}`);
  const server = backend();
  await run(['rank', 'Texas studios filling a January training'], server);
  assert.ok(!server.state.calls.some((c) => c.path === '/nexus/people/search'), 'no person search');
});

test('rank: the head line, one block per tier, every wording, and the next thing', async () => {
  const server = backend();
  const r = await run(['rank', 'texas studios filling a january training'], server);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'Texas studios filling a January training · 5 people · Nov 23 · 1 S, 1 A, 1 B, 2 need a reason');
  assert.match(r.out, /^S · 4 days left\n {2}Rae Sample, Owner at Rae Studio, Austin\n {2}Owner decides alone/m);
  assert.match(r.out, /why: Posted a January training with 3 seats left \(raestudio\.example\)/);
  assert.match(r.out, /decides: Rae, the owner \(raestudio\.example\)/);
  assert.match(r.out, /email: seen on their site/);
  assert.match(r.out, /way in: through Bo Example/);
  assert.match(r.out, /^A · closes today\n {2}Bo Example, Director at Bo Dance, Dallas/m);
  assert.match(r.out, /why: Hiring a front desk\n/, 'a source that is not a link shows no host');
  assert.match(r.out, /email: secondhand\n {2}way in: you know them\n {2}stage: replied\n {2}replied, waiting on you\n {2}missing: who decides/);
  assert.match(r.out, /^B · window closed 3 days ago\n {2}Cy Person, Cy Yoga\n/m);
  assert.match(r.out, /email: not checked\n {2}way in: cold/);
  assert.match(r.out, /missing: why now, who decides, a checked email/);
  assert.match(r.out, /^No tier · no date\n {2}Dee Tester, Owner, Houston\n/m);
  assert.match(r.out, /email: no email/);
  assert.match(r.out, /missing: why now, a date, who decides, a checked email/);
  assert.match(r.out, /^No tier · 1 day left\n {2}Eve Made\n/m);
  assert.ok(r.out.indexOf('Rae Sample') < r.out.indexOf('Bo Example, Director') && r.out.indexOf('Cy Person') < r.out.indexOf('Dee Tester'), 'the backend order is kept');
  assert.equal(lines.at(-1), 'Next: Bo Example replied and is waiting on you. Answer them first.');
  assert.doesNotMatch(r.out, /S_|why_now|replied_waiting|own_site|email_check/, 'no codes on screen');
  assert.equal(server.state.calls.at(-1).path, `/nexus/lists/${LIST}/ranked`);
  assert.equal(writes(server).length, 0, 'nothing is written or sent');
});

test('rank: next names the first S row when no one is waiting, else asks for dates', async () => {
  const noWait = ROWS.map((r) => ({ ...r, replied_waiting: false }));
  const a = await run(['rank', LIST], backend({ [`GET /nexus/lists/${LIST}/ranked`]: { ok: true, status: 200, data: { ...RANKED, rows: noWait } } }));
  assert.match(a.out.split('\n').at(-1), /^Next: work Rae Sample first, 4 days left\.$/);
  const undated = ROWS.slice(1).map((r) => ({ ...r, tier: r.tier === 'S' ? 'A' : r.tier, replied_waiting: false, missing: ['window'] }));
  const b = await run(['rank', LIST], backend({ [`GET /nexus/lists/${LIST}/ranked`]: { ok: true, status: 200, data: { ...RANKED, rows: undated } } }));
  assert.equal(b.out.split('\n').at(-1), 'Next: most of this list has no date. Add one: atris nexus window "Bo Example" <YYYY-MM-DD> --source <link>');
});

test('rank --tier keeps one tier, none keeps the untiered', async () => {
  for (const [tier, keep, drop] of [['S', 'Rae Sample', 'Cy Person'], ['a', 'Bo Example, Director', 'Rae Sample, Owner'], ['B', 'Cy Person', 'Dee Tester'], ['none', 'Dee Tester', 'Cy Person']]) {
    const r = await run(['rank', LIST, '--tier', tier], backend());
    assert.equal(r.code, 0);
    assert.ok(r.out.includes(keep), `--tier ${tier} keeps ${keep}`);
    assert.ok(!r.out.includes(drop), `--tier ${tier} drops ${drop}`);
  }
  const none = await run(['rank', LIST, '--tier', 'none'], backend());
  assert.match(none.out, /Eve Made/);
  const bad = await run(['rank', LIST, '--tier', 'C'], backend());
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--tier takes S, A, B or none/);
});

test('rank --limit caps and says how many are left out', async () => {
  const r = await run(['rank', LIST, '--limit', '2'], backend());
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('Bo Example, Director') && !r.out.includes('Cy Person'));
  assert.match(r.out, /3 more not shown\. See them with --limit 5\./);
  const bad = await run(['rank', LIST, '--limit', '0'], backend());
  assert.equal(bad.code, 2);
  const server = backend();
  await run(['rank', LIST, '--limit', 'x'], server);
  assert.equal(server.state.calls.length, 0, 'a bad flag makes no call');
});

test('rank sends the local calendar day, not the UTC one, so days left count from your own day', async () => {
  // Just after midnight and late in the evening, local time: in any zone but UTC one of these is
  // a different day in UTC, so a toISOString day would fail one of them.
  for (const now of [new Date(2026, 10, 23, 0, 30), new Date(2026, 10, 23, 23, 30)]) {
    const server = backend();
    const r = await run(['rank', LIST], server, PERSON, now);
    assert.equal(r.code, 0, r.err);
    const call = server.state.calls.find((c) => c.path === `/nexus/lists/${LIST}/ranked`);
    assert.equal(new URL(call.url, 'https://x.test').searchParams.get('day'), '2026-11-23');
  }
  const j = await run(['rank', LIST, '--json'], backend(), PERSON, new Date(2026, 10, 23, 23, 30));
  assert.deepEqual(JSON.parse(j.out), RANKED);
});

test('rank --json prints the backend answer untouched', async () => {
  const r = await run(['rank', LIST, '--json'], backend());
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), RANKED);
});

test('an older backend: one plain line, exit 1, no stack trace', async () => {
  const server = backend({ [`GET /nexus/lists/${LIST}/ranked`]: { ok: false, status: 404, data: { detail: 'Not Found' } } });
  const r = await run(['rank', LIST], server);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'Ranking a list needs the newest Atris, and the service you reached does not have it yet. Nothing was changed.');
  assert.doesNotMatch(r.err, /at |Error/);
  const j = await run(['rank', LIST, '--json'], server);
  assert.equal(j.code, 1);
  assert.equal(JSON.parse(j.out).not_live, true);
});

test('rank: a list that is not yours names the close ones; an empty list says so', async () => {
  const r = await run(['rank', 'Texas studios'], backend());
  assert.equal(r.code, 1);
  assert.match(r.err, /None of your saved lists is called "Texas studios"/);
  const empty = backend({ [`GET /nexus/lists/${OTHER}/ranked`]: { ok: true, status: 200, data: { list: { id: OTHER, name: 'Utah studios', people: 0 }, as_of: '2026-11-23', counts: { S: 0, A: 0, B: 0, none: 0 }, rows: [] } } });
  const e = await run(['rank', 'Utah studios'], empty);
  assert.equal(e.code, 0);
  assert.equal(e.out, 'Utah studios · 0 people · Nov 23 · no one ranked yet\nNo one is on Utah studios yet.');
  const none = await run(['rank'], backend());
  assert.equal(none.code, 2);
});

test('window sets window_ends through set, with the source', async () => {
  const server = backend({}, [card(RAE, 'Rae Sample')]);
  const r = await run(['window', 'Rae Sample', '2026-12-15', '--source', 'https://raestudio.example/news'], server, HELPER);
  assert.equal(r.code, 0, r.err);
  const [w] = writes(server);
  assert.equal(w.path, `/nexus/people/${RAE}/mine`);
  assert.deepEqual(w.body.extra.col_window_ends, { v: '2026-12-15', by: 'scout', at: NOW.toISOString(), src: 'https://raestudio.example/news' });
});

test('window refuses a date that is not real, before any call', async () => {
  for (const bad of ['2026-02-30', '2026-13-01', '12/15/2026', 'tomorrow', '2026-1-5']) {
    const server = backend({}, [card(RAE, 'Rae Sample')]);
    const r = await run(['window', 'Rae Sample', bad, '--source', 'x'], server);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /is not a real date/);
    assert.equal(server.state.calls.length, 0, `${bad} makes no call`);
  }
  const missing = await run(['window', 'Rae Sample'], backend());
  assert.equal(missing.code, 2);
});

test('window clear takes it off; a helper cannot clear the owner\'s date', async () => {
  const server = backend({}, [card(RAE, 'Rae Sample', { col_window_ends: { v: '2026-12-15', by: 'scout', at: 'x', src: 'y' } })]);
  const r = await run(['window', 'Rae Sample', 'clear'], server);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes(server)[0].body.extra.col_window_ends, null);
  const mine = backend({}, [card(RAE, 'Rae Sample', { col_window_ends: { v: '2026-12-15', by: 'you', at: 'x' } })]);
  const h = await run(['window', 'Rae Sample', 'clear'], mine, HELPER);
  assert.equal(h.code, 1);
  assert.equal(writes(mine).length, 0);
});

test('decides sets decider; a helper must give a source and never changes the owner\'s value', async () => {
  const server = backend({}, [card(RAE, 'Rae Sample')]);
  const r = await run(['decides', 'Rae Sample', 'Rae, the owner'], server);
  assert.equal(r.code, 0, r.err);
  assert.equal(writes(server)[0].body.extra.col_decider.v, 'Rae, the owner');
  assert.equal(writes(server)[0].body.extra.col_decider.by, 'you');

  const nosrc = backend({}, [card(RAE, 'Rae Sample')]);
  const h = await run(['decides', 'Rae Sample', 'Rae'], nosrc, HELPER);
  assert.equal(h.code, 2);
  assert.match(h.err, /must say where it found this/);
  assert.equal(nosrc.state.calls.length, 0);

  const mine = backend({}, [card(RAE, 'Rae Sample', { col_decider: { v: 'Rae', by: 'you', at: 'x' } })]);
  const kept = await run(['decides', 'Rae Sample', 'Someone else', '--source', 'https://x.example'], mine, HELPER);
  assert.equal(kept.code, 1);
  assert.match(kept.err, /set decider on Rae Sample yourself/);
  assert.equal(writes(mine).length, 0);

  const window = backend({}, [card(RAE, 'Rae Sample', { col_window_ends: { v: '2026-12-15', by: 'you', at: 'x' } })]);
  const w = await run(['window', 'Rae Sample', '2026-12-20', '--source', 'https://x.example'], window, HELPER);
  assert.equal(w.code, 1);
  assert.equal(writes(window).length, 0);
});

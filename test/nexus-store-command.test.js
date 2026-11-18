'use strict';

// atris nexus through the shared people store, with every backend call faked.
// Not run against a live backend. Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');

const NOW = new Date(2026, 10, 14, 12);
const FILE = 'files/people.json';
const RAE = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const CY = '33333333-3333-4333-8333-333333333333';
const AUSTIN = '44444444-4444-4444-8444-444444444444';

function mineCard(id, name, over = {}, priv = {}) {
  return {
    id, is_public: false, mine: true, name, title: null, company_name: null, location_raw: null, place: null,
    private: { stage: 'found', closeness: 1, note: null, next_move: null, due_on: null, paid_cents: 0, paid_checked: false, last_touch_at: null, via_person_id: null, ...priv },
    ...over,
  };
}

function seed() {
  return {
    people: [
      mineCard(RAE, 'Rae Sample', { title: 'Founder', company_name: 'Sample Co', location_raw: 'Austin, TX' }, { stage: 'replied', note: 'Likes email', next_move: 'Call back Friday', due_on: '2026-11-20', paid_cents: 5000, last_touch_at: '2026-11-13T10:00:00+00:00' }),
      mineCard(BO, 'Bo Example', { company_name: 'Example Inc' }, { closeness: 2, stage: 'found' }),
    ],
    ties: { [RAE]: [{ id: 't1', other_person_id: BO, other_name: 'Bo Example', label: 'knows' }] },
    touches: { [RAE]: [{ id: 'x1', person_id: RAE, kind: 'sent', body: 'hello', at: '2026-11-10T09:00:00+00:00' }] },
    goal: null,
    places: [{ id: AUSTIN, city: 'Austin', region: 'Texas', country: 'United States', public_count: 3, my_count: 1 }],
  };
}

// The saved list, as the old file held it.
function fileList(extra = []) {
  return {
    nodes: [
      { t: 'p', n: 'You', me: 1, d: 0 },
      { t: 'p', n: 'Cy Placeholder', d: 1, status: 'replied', last: '2026-11-01', co: 'Figma' },
      ...extra,
    ],
    edges: [[0, 1, 'knows']],
  };
}

// A stand-in for the store and for the saved-list file. `down` makes every /nexus call fail with that status.
// `search: false` is an older backend without the search route (405, as the card route answers).
function backend({ data = seed(), file = JSON.stringify(fileList()), down = null, fail = {}, search = true } = {}) {
  const state = { calls: [], writes: [], file, data };
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, data: body, error: body && body.detail });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body, options });
    if (url.pathname === '/memory/file') {
      if (state.file === null) return answer(400, { detail: `No file at ${FILE}` });
      return answer(200, { text: state.file });
    }
    if (url.pathname === '/memory/write') {
      state.writes.push(options.body.text);
      state.file = options.body.text;
      return answer(200, {});
    }
    if (down === 0) return { ok: false, status: 0, data: null, error: 'ECONNREFUSED' };
    if (down) return answer(down, { detail: 'down' });
    const key = `${method} ${url.pathname}`;
    if (fail[key]) return answer(fail[key], { detail: 'failed' });
    const d = state.data;
    let m;
    // The store's own filters: words in name or company, stage, closeness and list.
    const filter = ({ q, stage, closeness, group, limit = 50, offset = 0 }) => {
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = d.people.filter((c) => words.every((w) => `${c.name} ${c.company_name || ''}`.toLowerCase().includes(w))
        && (!stage || c.private.stage === stage)
        && (!closeness || c.private.closeness === Number(closeness))
        && (!group || c.private.group_name === group));
      return answer(200, { total: hits.length, limit: Number(limit), offset: Number(offset), people: hits.slice(Number(offset), Number(offset) + Number(limit)) });
    };
    if (key === 'GET /nexus/people') return filter(Object.fromEntries(url.searchParams));
    if (key === 'POST /nexus/people/search') return search ? filter(options.body) : answer(405, { detail: 'Method Not Allowed' });
    if (key === 'GET /nexus/people/counts') return answer(200, d.counts);
    if ((m = /^GET \/nexus\/people\/([^/]+)$/.exec(key))) {
      const card = d.people.find((c) => c.id === m[1]);
      return card ? answer(200, { card, ties: d.ties[m[1]] || [], touches: d.touches[m[1]] || [] }) : answer(404, { detail: 'Not found' });
    }
    if ((m = /^PATCH \/nexus\/people\/([^/]+)\/mine$/.exec(key))) {
      const card = d.people.find((c) => c.id === m[1]);
      card.private = { ...card.private, ...options.body };
      return answer(200, { card });
    }
    if (key === 'POST /nexus/touches') return answer(200, { touch: { id: 'new', ...options.body, at: '2026-11-14T12:00:00+00:00' } });
    if (key === 'POST /nexus/people') {
      const card = mineCard('99999999-9999-4999-8999-999999999999', options.body.name, { title: options.body.title || null, company_name: options.body.company || null, location_raw: options.body.location || null }, { stage: options.body.stage });
      d.people.push(card);
      return answer(200, { card, created: true });
    }
    if (key === 'GET /nexus/today') return answer(200, d.today || { today: '2026-11-14', tz: url.searchParams.get('tz') || 'UTC', total: 0, people: [] });
    if (key === 'GET /nexus/wall') return answer(200, d.wall);
    if (key === 'GET /nexus/goal') return answer(200, { goal: d.goal });
    if (key === 'PUT /nexus/goal') {
      d.goal = { ...options.body, updated_at: '2026-11-14T12:00:00+00:00' };
      return answer(200, { goal: d.goal });
    }
    if (key === 'GET /nexus/places') return answer(200, { places: d.places });
    if ((m = /^GET \/nexus\/places\/([^/]+)\/people$/.exec(key))) {
      const place = d.places.find((p) => p.id === m[1]);
      return answer(200, { place, total: d.cityPeople.length, people: d.cityPeople });
    }
    if (key === 'POST /nexus/import') return answer(200, d.imported || { created: 1, matched: 0, skipped: 0, ties_added: 0, touches_added: 0, skipped_reasons: {}, skipped_examples: [], conflicts: [] });
    throw new Error(`unexpected call ${key}`);
  };
  return { state, request };
}

async function run(args, server = backend(), deps = {}) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server.request,
    now: () => NOW,
    tz: 'Europe/London',
    ...deps,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

const storeCalls = (server) => server.state.calls.filter((c) => c.path.startsWith('/nexus/')).map((c) => `${c.method} ${c.path}`);
const fileCalls = (server) => server.state.calls.filter((c) => c.path.startsWith('/memory/')).map((c) => `${c.method} ${c.path}`);

test('today asks the store with the time zone and prints each reason with its days', async () => {
  const data = seed();
  data.today = {
    today: '2026-11-14', tz: 'Europe/London', total: 6,
    people: [
      { ...data.people[0], reason: 'reply_waiting', days: 3 },
      { ...data.people[1], reason: 'follow_up_overdue', days: 2 },
      { ...mineCard(CY, 'Cy Placeholder'), reason: 'follow_up_due', days: 0 },
      { ...mineCard('55555555-5555-4555-8555-555555555555', 'Di Four'), reason: 'no_follow_up_yet', days: 5 },
      { ...mineCard('66666666-6666-4666-8666-666666666666', 'Ed Five'), reason: 'met_then_quiet', days: 4 },
      { ...mineCard('77777777-7777-4777-8777-777777777777', 'Flo Six'), reason: 'gone_quiet', days: 45 },
    ],
  };
  const server = backend({ data });
  const { code, out, err } = await run([], server);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.deepEqual(server.state.calls.map((c) => [c.method, c.path, c.query]), [['GET', '/nexus/today', { tz: 'Europe/London' }]]);
  assert.match(out, /Rae Sample: Wrote back 3 days ago\. Answer them\./);
  assert.match(out, /Bo Example: Follow-up is 2 days overdue\./);
  assert.match(out, /Cy Placeholder: Follow-up is due today\./);
  assert.match(out, /Di Four: Sent 5 days ago, no follow-up yet\./);
  assert.match(out, /Ed Five: Met 4 days ago, nothing since\./);
  assert.doesNotMatch(out, /Flo Six/, 'the morning list stops at five');
  assert.match(out, /Showing 5 of 6\. Add --all for the rest\.$/);

  const all = await run(['--all'], backend({ data }));
  assert.match(all.out, /Flo Six: 45 days since you talked\. Check in\./);
  assert.match(all.out, /Flo Six[^\n]*$/, 'nothing left to show, so no footer');

  const json = await run(['--json'], backend({ data }));
  assert.equal(JSON.parse(json.out).people.length, 6, 'agents get the store\'s whole answer');
});

test('wall flags people at Paying with no money recorded', async () => {
  const data = seed();
  data.wall = { today: '2026-11-14', people: 12, stages: { found: 3, reached_out: 0, replied: 0, met: 0, paying: 9, partner: 0 }, sent: 0, replied: 0, follow_ups_due_today: 0, follow_ups_overdue: 0, no_follow_up_yet: 0, paid_cents: 0, unchecked_paid_cents: 0, by_place: [], by_group: [], goal: null };
  const wall = await run(['wall'], backend({ data }));
  assert.match(wall.out, /9 people are at Paying, but no money is recorded\. Record it: atris nexus paid "<name>" <amount> --checked/);
  data.wall.paid_cents = 5000;
  assert.doesNotMatch((await run(['wall'], backend({ data }))).out, /no money is recorded/);

  data.counts = { total: 10, groups: [], stages: [{ stage: 'found', count: 10 }] };
  const count = await run(['count'], backend({ data }));
  assert.equal(count.out, '10 people on your list.\nBy stage: 10 found.', 'nothing unset, no gap line');
});

test('--json prints the store\'s answer unchanged on every read', async () => {
  const data = seed();
  data.today = { today: '2026-11-14', tz: 'Europe/London', total: 1, people: [{ ...data.people[0], reason: 'reply_waiting', days: 1 }] };
  data.wall = { today: '2026-11-14', tz: 'UTC', people: 2, stages: {}, sent: 1, replied: 0, follow_ups_due_today: 0, follow_ups_overdue: 0, no_follow_up_yet: 0, paid_cents: 0, unchecked_paid_cents: 0, by_place: [], by_group: [], goal: null };
  data.cityPeople = [data.people[0]];
  const server = backend({ data });
  const same = async (args, answer) => {
    const { code, out } = await run([...args, '--json'], server);
    assert.equal(code, 0);
    assert.equal(out, JSON.stringify(answer), args.join(' '));
  };
  await same([], data.today);
  await same(['wall'], data.wall);
  await same(['find', 'rae'], { total: 1, limit: 25, offset: 0, people: [data.people[0]] });
  await same(['Rae Sample'], { card: data.people[0], ties: data.ties[RAE], touches: data.touches[RAE] });
  await same(['goal'], { goal: null });
  await same(['city', 'austin'], { place: data.places[0], total: 1, people: data.cityPeople });
});

test('a name shows the card with its ties and recent activity', async () => {
  const server = backend();
  const { code, out } = await run(['rae sample'], server);
  assert.equal(code, 0);
  assert.deepEqual(storeCalls(server), ['POST /nexus/people/search', `GET /nexus/people/${RAE}`]);
  assert.equal(server.state.calls[0].body.q, 'rae sample');
  assert.deepEqual(server.state.calls[0].query, {}, 'the name never rides in the address');
  const lines = out.split('\n');
  assert.equal(lines[0], 'Rae Sample');
  assert.equal(lines[1], 'Founder · Sample Co · Austin, TX');
  assert.match(out, /Closeness: Direct/);
  assert.match(out, /Stage: Replied, Nov 13/);
  assert.match(out, /Next: Call back Friday\./);
  assert.match(out, /Follow up: Nov 20/);
  assert.match(out, /Paid: \$50\.00, not checked, so not counted/);
  assert.match(out, /Nov 10\s+Email sent  hello/);
  assert.match(out, /Likes email/);
  assert.match(out, /Ties: Bo Example/);
});

test('a name that matches several people lists them and exits 1', async () => {
  const data = seed();
  data.people.push(mineCard(CY, 'Rae Other'));
  const { code, err } = await run(['rae'], backend({ data }));
  assert.equal(code, 1);
  assert.match(err, /2 people match "rae"/);
  assert.match(err, /Rae Sample/);
});

test('find uses the q filter, 25 at a time, and 200 with --all', async () => {
  const server = backend();
  const { code, out } = await run(['find', 'example'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.method, c.path, c.query, c.body]), [['POST', '/nexus/people/search', {}, { q: 'example', limit: 25, offset: 0 }]]);
  assert.match(out, /1 person matches "example"\./);
  assert.match(out, /Bo Example\s+Example Inc\s+One intro$/m, 'Found is where every card starts, so it is left blank');
  await run(['find', 'example', '--all'], server);
  assert.equal(server.state.calls[1].body.limit, 200);
});

test('note adds a touch of kind note, then updates the note keeping what was there', async () => {
  const server = backend();
  const { code, out } = await run(['note', 'Rae Sample', 'Met', 'at', 'the', 'summit'], server);
  assert.equal(code, 0);
  assert.deepEqual(storeCalls(server), ['POST /nexus/people/search', 'POST /nexus/touches', `PATCH /nexus/people/${RAE}/mine`]);
  assert.deepEqual(server.state.calls[1].body, { person_id: RAE, kind: 'note', body: 'Met at the summit' });
  assert.deepEqual(server.state.calls[2].body, { note: 'Likes email | Met at the summit' });
  assert.equal(server.state.calls[1].options.retries, 0, 'a send that adds is never repeated');
  assert.match(out, /Noted on Rae Sample: Met at the summit/);
  assert.deepEqual(fileCalls(server), []);
});

test('stage patches the stage; found, reached, met and the old file words all map', async () => {
  for (const [word, stage] of [['found', 'found'], ['reached', 'reached_out'], ['replied', 'replied'], ['met', 'met'], ['paying', 'paying'], ['partner', 'partner'], ['sent', 'reached_out'], ['prospect', 'found']]) {
    const server = backend();
    const { code } = await run(['stage', 'Bo Example', word], server);
    assert.equal(code, 0, word);
    assert.deepEqual(server.state.calls[1].body, { stage }, word);
  }
  const server = backend();
  const { code, out } = await run(['stage', 'Bo Example', 'reached'], server);
  assert.equal(code, 0);
  assert.match(out, /Bo Example is now Reached out \(was Found\)\./);

  const bad = backend();
  assert.equal((await run(['stage', 'Bo Example', 'married'], bad)).code, 2);
  assert.deepEqual(bad.state.calls, []);
});

test('add claims only what it is told: Found, no closeness, no list, unless the flags say so', async () => {
  const server = backend();
  const { code, out } = await run(['add', 'Di Four', '--title', 'Coach', '--company=Four LLC', '--city', 'London, UK', '--email', 'di@example.com', '--linkedin', 'https://www.linkedin.com/in/di-four', '--note', 'LinkedIn connection'], server);
  assert.equal(code, 0);
  assert.deepEqual(storeCalls(server), ['POST /nexus/people/search', 'POST /nexus/people']);
  assert.deepEqual(server.state.calls[1].body, {
    name: 'Di Four', stage: 'found', source: 'manual',
    title: 'Coach', company: 'Four LLC', location: 'London, UK', email: 'di@example.com', linkedin: 'https://www.linkedin.com/in/di-four', note: 'LinkedIn connection',
  });
  assert.equal(server.state.calls[1].options.retries, 0);
  assert.match(out, /Added Di Four \(Coach · Four LLC · London, UK\)\.$/m);

  const met = backend();
  const told = await run(['add', 'Ed Five', '--stage', 'met', '--closeness', 'direct', '--group', 'People you met'], met);
  assert.equal(told.code, 0);
  assert.deepEqual(met.state.calls[1].body, { name: 'Ed Five', stage: 'met', source: 'manual', closeness: 1, group_name: 'People you met' });
  assert.match(told.out, /Added Ed Five: Met, direct, on People you met\./);

  const bad = backend();
  const refusedStage = await run(['add', 'Fay Six', '--stage', 'friend'], bad);
  assert.equal(refusedStage.code, 2);
  assert.deepEqual(bad.state.calls, [], 'a bad stage is refused before any call');

  const twin = backend();
  const refused = await run(['add', 'rae sample'], twin);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Rae Sample is already on your list\./);
  assert.deepEqual(storeCalls(twin), ['POST /nexus/people/search']);
});

test('due sets the follow-up date and the next move; bad dates are refused before any call', async () => {
  const server = backend();
  const { code, out } = await run(['due', 'Bo Example', '2026-11-20', 'Send', 'the', 'price'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls[1].body, { due_on: '2026-11-20', next_move: 'Send the price' });
  assert.match(out, /Follow-up for Bo Example set for Nov 20\. Next move: Send the price/);

  const tomorrow = backend();
  await run(['due', 'Bo Example', 'tomorrow'], tomorrow);
  assert.deepEqual(tomorrow.state.calls[1].body, { due_on: '2026-11-15' });

  const cleared = backend();
  const gone = await run(['due', 'Bo Example', 'clear'], cleared);
  assert.deepEqual(cleared.state.calls[1].body, { due_on: null });
  assert.match(gone.out, /cleared/);

  for (const bad of [['due', 'Bo Example', '2026-02-31'], ['due', 'Bo Example', 'soon'], ['due', 'Bo Example']]) {
    const none = backend();
    assert.equal((await run(bad, none)).code, 2, bad.join(' '));
    assert.deepEqual(none.state.calls, []);
  }
});

test('paid records money as not checked, and only --checked marks it checked', async () => {
  const server = backend();
  const open = await run(['paid', 'Bo Example', '$1,200.50'], server);
  assert.equal(open.code, 0);
  assert.deepEqual(server.state.calls[1].body, { paid_cents: 120050, paid_checked: false });
  assert.match(open.out, /\$1,200\.50 recorded for Bo Example\. Not checked, so it does not count yet\./);

  const checked = await run(['paid', 'Bo Example', '50', '--checked'], server);
  assert.deepEqual(server.state.calls[server.state.calls.length - 1].body, { paid_cents: 5000, paid_checked: true });
  assert.match(checked.out, /\$50\.00 recorded for Bo Example\. Checked, so it counts on the wall\./);

  for (const bad of [['paid', 'Bo Example', 'lots'], ['paid', 'Bo Example', '-5'], ['paid', 'Bo Example', '1.234'], ['paid', 'Bo Example']]) {
    const none = backend();
    assert.equal((await run(bad, none)).code, 2, bad.join(' '));
    assert.deepEqual(none.state.calls, []);
  }
});

test('wall prints aligned numbers, checked money against the goal, and unchecked money apart', async () => {
  const data = seed();
  data.wall = {
    today: '2026-11-14', tz: 'Europe/London', people: 124, stages: {}, sent: 61, replied: 14,
    follow_ups_due_today: 3, follow_ups_overdue: 5, no_follow_up_yet: 9, people_with_three_follow_ups: 2,
    paid_cents: 45000, unchecked_paid_cents: 7050,
    by_group: [{ group_name: 'Founders', people: 40, sent: 30, replied: 9, paying: 2, paid_cents: 45000 }, { group_name: 'Coaches', people: 12, sent: 5, replied: 1, paying: 0, paid_cents: 0 }],
    by_place: [{ place_id: AUSTIN, city: 'Austin', region: 'Texas', country: 'United States', people: 30, sent: 20, replied: 6, paying: 1 }, { place_id: BO, city: 'London', region: null, country: 'United Kingdom', people: 22, sent: 9, replied: 2, paying: 0 }],
    goal: { goal_cents: 1000000, goal_date: '2026-12-15', updated_at: '2026-11-01T00:00:00+00:00' },
  };
  const server = backend({ data });
  const { code, out } = await run(['wall'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.path, c.query]), [['/nexus/wall', { tz: 'Europe/London' }]]);
  assert.equal(out, [
    'Wall, Nov 14',
    '  People                    124',
    '  Sent                       61',
    '  Replied                    14',
    '  Follow-ups due today        3',
    '  Follow-ups overdue          5',
    '  No follow-up yet            9',
    '  Paid (checked only)   $450.00  of $10,000.00 (4%), by Dec 15',
    '',
    '  Not counted: $70.50 recorded but not checked. Only checked money counts.',
    '',
    'Top groups',
    '  Founders  40 people  30 sent  9 replied  2 paying  $450.00 paid',
    '  Coaches   12 people   5 sent  1 replied  0 paying    $0.00 paid',
    '',
    'Top cities',
    '  Austin, Texas           30 people  20 sent  6 replied  1 paying',
    '  London, United Kingdom  22 people   9 sent  2 replied  0 paying',
  ].join('\n'));

  // Unchecked money is never added into the paid line, and no goal means no "of".
  const bare = seed();
  bare.wall = { ...data.wall, paid_cents: 0, unchecked_paid_cents: 0, goal: null, by_group: [], by_place: [] };
  const plain = await run(['wall'], backend({ data: bare }));
  assert.match(plain.out, /Paid \(checked only\)\s+\$0\.00$/m);
  assert.doesNotMatch(plain.out, /Not counted/);
});

test('goal shows, sets, and keeps the date when only the amount changes', async () => {
  const server = backend();
  assert.match((await run(['goal'], server)).out, /No goal set\. Set one: atris nexus goal 10000 2026-12-15/);

  const set = await run(['goal', '10000', '2026-12-15'], server);
  assert.equal(set.code, 0);
  assert.deepEqual(server.state.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [{ goal_cents: 1000000, goal_date: '2026-12-15' }]);
  assert.match(set.out, /Goal set: \$10,000\.00 by Dec 15/);

  const amountOnly = await run(['goal', '12500.50'], server);
  assert.deepEqual(server.state.calls.filter((c) => c.method === 'PUT').pop().body, { goal_cents: 1250050, goal_date: '2026-12-15' });
  assert.match(amountOnly.out, /\$12,500\.50 by Dec 15/);

  const dateOnly = await run(['goal', '2027-01-31'], server);
  assert.deepEqual(server.state.calls.filter((c) => c.method === 'PUT').pop().body, { goal_cents: 1250050, goal_date: '2027-01-31' });
  assert.match(dateOnly.out, /by Jan 31, 2027/);
  assert.match((await run(['goal'], server)).out, /^Goal: \$12,500\.50 by Jan 31, 2027$/);

  const bad = backend();
  assert.equal((await run(['goal', 'ten thousand'], bad)).code, 2);
  assert.deepEqual(bad.state.calls, []);
});

test('city lists the people in that city, yours marked', async () => {
  const data = seed();
  data.cityPeople = [data.people[0], { id: CY, is_public: true, mine: false, name: 'Pat Public', title: null, company_name: 'Public Co', private: null }];
  const server = backend({ data });
  const { code, out } = await run(['city', 'Austin'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.path, c.query]), [['/nexus/places', {}], [`/nexus/places/${AUSTIN}/people`, { limit: '50' }]]);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Austin, Texas: 2 people, 1 yours');
  assert.match(lines[1], /^ {2}Rae Sample\s+Sample Co\s+Replied\s+yours$/);
  assert.match(lines[2], /^ {2}Pat Public\s+Public Co$/);

  assert.match((await run(['city', 'austin, texas'], backend({ data }))).out, /^Austin, Texas/);
  data.places[0].my_count = 7;
  assert.match((await run(['city', 'Austin'], backend({ data }))).out, /^Austin, Texas: 2 people, 7 yours/, 'yours counts the whole city, not one page');
  const missing = await run(['city', 'Nowhere'], backend({ data }));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No city called "Nowhere"/);
  const two = seed();
  two.places.push({ id: BO, city: 'Austin', region: 'Minnesota', country: 'United States', public_count: 1, my_count: 0 });
  const several = await run(['city', 'Austin'], backend({ data: two }));
  assert.equal(several.code, 1);
  assert.match(several.err, /2 places match "Austin"/);
});

// ---- list, search and count ----

// Sixty made-up people: every third one replied, every other one an intro away, the first ten in "Investors".
function crowd() {
  const people = [];
  for (let i = 0; i < 60; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    people.push(mineCard(id, `Person ${String(i).padStart(2, '0')}`, {}, { stage: i % 3 === 0 ? 'replied' : 'found', closeness: i % 2 ? 2 : 1, group_name: i < 10 ? 'Investors' : 'People you met' }));
  }
  return { ...seed(), people };
}

test('list asks for a plain page, 50 at a time, and says how to get the next one', async () => {
  const server = backend({ data: crowd() });
  const { code, out } = await run(['list'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.method, c.path, c.query]), [['GET', '/nexus/people', { limit: '50' }]]);
  const lines = out.split('\n');
  assert.equal(lines[0], '60 people on your list.');
  assert.match(lines[1], /^Person 00\s+Direct\s+Replied$/);
  assert.equal(lines.length, 53);
  assert.equal(lines[51], 'Showing 1 to 50 of 60.');
  assert.equal(lines[52], 'Add --offset 50 for the next page.');

  const next = await run(['list', '--offset', '50'], backend({ data: crowd() }));
  assert.deepEqual(next.server.state.calls[0].query, { limit: '50', offset: '50' });
  assert.match(next.out, /Person 59/);
  assert.match(next.out, /Showing 51 to 60 of 60\.$/);

  const past = await run(['list', '--offset=500'], backend({ data: crowd() }));
  assert.match(past.out, /No one past 500\. Try a smaller --offset\./);

  const json = await run(['list', '--limit', '2', '--json'], backend({ data: crowd() }));
  const answer = JSON.parse(json.out);
  assert.deepEqual([answer.total, answer.limit, answer.offset, answer.people.length], [60, 2, 0, 2], 'the store\'s own answer');
});

test('list with a filter sends it in a search body, and every filter is checked before any call', async () => {
  const server = backend({ data: crowd() });
  const { code, out } = await run(['list', '--stage', 'replied', '--closeness', 'direct', '--group', 'Investors', '--limit', '3'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.method, c.path, c.query, c.body]), [['POST', '/nexus/people/search', {}, { limit: 3, offset: 0, group: 'Investors', stage: 'replied', closeness: 1 }]]);
  assert.match(out, /^2 people on your list \(replied, direct, in "Investors"\)\./);

  for (const [args, said] of [
    [['--limit', '0'], /--limit takes a whole number from 1 to 200/],
    [['--limit', '201'], /--limit takes a whole number from 1 to 200/],
    [['--limit', 'ten'], /--limit takes a whole number/],
    [['--offset', '-1'], /--offset takes a whole number, 0 or more/],
    [['--offset', '1.5'], /--offset takes a whole number/],
    [['--stage', 'cold'], /"cold" is not a stage/],
    [['--closeness', '3'], /"3" is not a closeness/],
    [['--group', ' '], /--group needs the name of a list/],
  ]) {
    const bad = backend();
    const res = await run(['list', ...args], bad);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.err, said, args.join(' '));
    assert.deepEqual(bad.state.calls, [], 'refused before any call');
  }
});

test('search puts the words and filters in the body, never the address, and pages like list', async () => {
  const server = backend({ data: crowd() });
  const { code, out } = await run(['search', 'person', '--closeness', 'intro', '--offset', '5', '--limit', '5'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => [c.method, c.path, c.query, c.body]), [['POST', '/nexus/people/search', {}, { limit: 5, offset: 5, q: 'person', closeness: 2 }]]);
  assert.match(out, /^30 people match "person" \(one intro\)\./);
  assert.match(out, /Person 11/);
  assert.match(out, /Showing 6 to 10 of 30\.\nAdd --offset 10 for the next page\.$/);

  const none = await run(['search', 'nobody', '--stage', 'paying'], backend({ data: crowd() }));
  assert.equal(none.out, 'No one on your list matches "nobody" (paying).');

  const bare = await run(['search'], backend());
  assert.equal(bare.code, 2);
  assert.match(bare.err, /needs words to look for\. To see everyone: atris nexus list/);
});

test('an older backend without the search route stops plainly, and words never go in the address', async () => {
  for (const args of [['search', 'person 1'], ['note', 'Rae Sample', 'hi'], ['list', '--group', 'Investors']]) {
    const server = backend({ data: crowd(), search: false });
    const res = await run(args, server);
    assert.equal(res.code, 1, args.join(' '));
    assert.match(res.err, /The people store does not know this command yet/);
    assert.deepEqual(storeCalls(server), ['POST /nexus/people/search'], 'no second try with the words in the address');
    assert.equal(server.state.writes.length, 0);
    assert.deepEqual(fileCalls(server), [], 'an older store is not a store that is down');
  }
});

test('count shows the store\'s counts by stage and its biggest lists', async () => {
  const groups = ['People you met', 'Investors', 'LinkedIn', 'Labs', 'Film', 'Music', 'Coaches'].map((name, i) => ({ name, count: 30 - i }));
  const data = { ...seed(), counts: { total: 60, groups, stages: [{ stage: 'found', count: 40 }, { stage: 'reached_out', count: 0 }, { stage: 'replied', count: 15 }, { stage: 'paying', count: 0 }] } };
  const server = backend({ data });
  const { code, out } = await run(['count'], server);
  assert.equal(code, 0);
  assert.deepEqual(storeCalls(server), ['GET /nexus/people/counts']);
  assert.equal(out, [
    '60 people on your list.',
    'By stage: 40 found, 15 replied, 5 not set.',
    'Biggest lists: People you met 30, Investors 29, LinkedIn 28, Labs 27, Film 26, and 2 more lists.',
  ].join('\n'));
  const json = await run(['count', '--json'], backend({ data }));
  assert.deepEqual(JSON.parse(json.out), data.counts, 'agents get the store\'s own answer');
});


test('list, search and count fall back to the saved list; filters need the store', async () => {
  const list = await run(['list'], backend({ down: 0 }));
  assert.equal(list.code, 0);
  assert.equal(list.err, 'Using your saved list. The people store did not answer.');
  assert.match(list.out, /^1 person on your list\.\nCy Placeholder/);

  const search = await run(['search', 'figma', '--json'], backend({ down: 500 }));
  assert.equal(search.code, 0);
  const found = JSON.parse(search.out);
  assert.deepEqual([found.total, found.limit, found.offset, found.people[0].name], [1, 25, 0, 'Cy Placeholder']);

  const count = await run(['count'], backend({ down: 502 }));
  assert.equal(count.code, 0);
  assert.match(count.out, /^1 person, /);

  const filtered = await run(['list', '--stage', 'met'], backend({ down: 0 }));
  assert.equal(filtered.code, 1);
  assert.match(filtered.err, /--stage, --closeness and --group need it/);
  assert.equal(filtered.server.state.writes.length, 0);
});

test('no Nexus command ever puts a search word or name in a web address', async () => {
  // A name nobody has, so every lookup runs to the end, and one that matches, so writes go through.
  const words = ['Zyxw Secretname', 'Rae Sample'];
  for (const word of words) {
    for (const args of [
      [word], ['find', word], ['search', word, '--group', 'Investors', '--stage', 'met'], ['list', '--group', word],
      ['note', word, 'hello'], ['stage', word, 'met'], ['due', word, 'tomorrow'], ['paid', word, '50'], ['add', word],
      ['city', word],
    ]) {
      const server = backend({ data: crowd() });
      server.state.data.people.push(mineCard(RAE, 'Rae Sample'));
      await run(args, server);
      for (const call of server.state.calls.filter((c) => c.path.startsWith('/nexus/'))) {
        const address = `${call.path}?${new URLSearchParams(call.query)}`.toLowerCase();
        for (const part of word.toLowerCase().split(' ')) {
          assert.ok(!address.includes(part), `${args.join(' ')} sent "${part}" in ${call.method} ${address}`);
        }
      }
    }
  }
});

test('a paused store (503) stops with one plain line and never writes to the saved list', async () => {
  for (const args of [['note', 'Cy Placeholder', 'hello'], ['add', 'New Person'], ['stage', 'Cy Placeholder', 'met'], []]) {
    const server = backend({ down: 503 });
    const res = await run(args, server);
    assert.equal(res.code, 1, args.join(' '));
    assert.match(res.err, /The people store is paused for a few minutes\. Nothing was saved\./);
    assert.equal(server.state.writes.length, 0, 'the saved list is never written while the store is paused');
  }
  const written = backend({ fail: { 'POST /nexus/touches': 503 } });
  const res = await run(['note', 'Rae Sample', 'hello'], written);
  assert.equal(res.code, 1);
  assert.match(res.err, /paused/);
  assert.equal(written.state.writes.length, 0);
});

// ---- when the store does not answer ----

for (const [label, down] of [['unreachable', 0], ['not found', 404], ['a server error', 500], ['a bad gateway', 502]]) { // 503 is a pause, tested below
  test(`${label}: reads fall back to the saved list with one plain line on stderr`, async () => {
    const server = backend({ down });
    const { code, out, err } = await run([], server);
    assert.equal(code, 0);
    assert.equal(err, 'Using your saved list. The people store did not answer.');
    assert.match(out, /Cy Placeholder: Wrote back\. Answer them\./);
    assert.deepEqual(storeCalls(server), ['GET /nexus/today']);
    assert.deepEqual(fileCalls(server), ['GET /memory/file']);

    const card = await run(['cy placeholder', '--json'], backend({ down }));
    assert.equal(card.code, 0);
    assert.equal(JSON.parse(card.out).person.name, 'Cy Placeholder', 'stdout stays the saved list\'s JSON');
    assert.equal(card.err, 'Using your saved list. The people store did not answer.');
  });

  test(`${label}: a change stops with one plain line and is saved nowhere`, async () => {
    for (const args of [['note', 'Cy Placeholder', 'hello'], ['stage', 'Cy Placeholder', 'met'], ['add', 'New Person']]) {
      const server = backend({ down });
      const { code, err } = await run(args, server);
      assert.equal(code, 1, args.join(' '));
      assert.equal(err, 'The people store did not answer, so nothing was saved. Try again in a moment.');
      assert.equal(server.state.writes.length, 0, 'the saved list is never written');
      assert.deepEqual(fileCalls(server), [], 'the saved list is not even read');
    }
  });

}

test('a store that already took a write is not followed by a second write to the saved list', async () => {
  const server = backend({ fail: { [`PATCH /nexus/people/${BO}/mine`]: 500 } });
  const { code, err } = await run(['stage', 'Bo Example', 'met'], server);
  assert.equal(code, 1);
  assert.match(err, /That did not save/);
  assert.deepEqual(fileCalls(server), []);
});

test('a note that is saved but whose card note did not update still reports success', async () => {
  const server = backend({ fail: { [`PATCH /nexus/people/${RAE}/mine`]: 500 } });
  const { code, out, err } = await run(['note', 'Rae Sample', 'hi'], server);
  assert.equal(code, 0);
  assert.match(out, /Noted on Rae Sample: hi/);
  assert.match(err, /note on the card did not update/);
  assert.deepEqual(fileCalls(server), []);
});

test('commands only the store can answer say so instead of using the saved list', async () => {
  for (const args of [['wall'], ['goal'], ['goal', '100'], ['due', 'Cy Placeholder', 'today'], ['paid', 'Cy Placeholder', '5'], ['city', 'Austin']]) {
    const server = backend({ down: 500 });
    const { code, err, out } = await run(args, server);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out, '');
    assert.match(err, /people store did not answer, and this command needs it/);
    assert.deepEqual(server.state.writes, []);
  }
});

// ---- 402 ----

test('402 does not fall back: one plain line, non-zero, and the saved list is never touched', async () => {
  for (const args of [[], ['Rae Sample'], ['find', 'x'], ['note', 'Rae Sample', 'hi'], ['wall']]) {
    const server = backend({ down: 402 });
    const { code, err, out } = await run(args, server);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out, '');
    assert.equal(err, 'Nexus needs a paid plan. Get it at https://nexus.atris.ai');
    assert.deepEqual(fileCalls(server), []);
  }
  const json = await run(['--json'], backend({ down: 402 }));
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.out), { ok: false, error: 'Nexus needs a paid plan. Get it at https://nexus.atris.ai', status: 402 });
});

test('a sign-in failure from the store stops with the sign-in line', async () => {
  const { code, err } = await run([], backend({ down: 401 }));
  assert.equal(code, 1);
  assert.match(err, /Sign in to see your people\. not logged in\. run: atris login/);
});

// ---- bring-over ----

test('bring-over posts the saved list once and leaves it untouched', async () => {
  const list = fileList([{ t: 'p', n: 'Di Four', d: 2, status: 'sent' }]);
  const text = JSON.stringify(list);
  const data = seed();
  data.imported = { created: 2, matched: 0, skipped: 0, ties_added: 1, touches_added: 3, skipped_reasons: {}, skipped_examples: [], conflicts: [] };
  const server = backend({ data, file: text });
  const { code, out } = await run(['bring-over'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls.map((c) => `${c.method} ${c.path}`), ['GET /memory/file', 'POST /nexus/import']);
  assert.deepEqual(server.state.calls[1].body, { nodes: list.nodes, edges: list.edges });
  assert.equal(server.state.calls[1].options.retries, 0);
  assert.deepEqual(server.state.writes, [], 'the file is never written');
  assert.equal(server.state.file, text, 'the file is never changed');
  assert.match(out, /Brought over 2 people: 2 new, 0 already there\./);
  assert.match(out, /1 tie and 3 notes added\. Your saved list was not changed\./);

  const json = await run(['bring-over', '--json'], backend({ data, file: text }));
  assert.equal(json.out, JSON.stringify(data.imported));
});

test('bring-over with nothing in the saved list sends nothing, and is refused when too big or when the store is down', async () => {
  const empty = backend({ file: JSON.stringify({ nodes: [{ t: 'p', n: 'You', me: 1, d: 0 }], edges: [] }) });
  const none = await run(['bring-over'], empty);
  assert.equal(none.code, 0);
  assert.match(none.out, /no one to bring over/);
  assert.deepEqual(storeCalls(empty), []);

  const many = Array.from({ length: 2001 }, (_, i) => ({ t: 'p', n: `Coach ${i}` }));
  const big = backend({ file: JSON.stringify(fileList(many)) });
  const refused = await run(['bring-over'], big);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /2002 people and one import takes at most 2000/);
  assert.deepEqual(storeCalls(big), []);

  const down = backend({ down: 500 });
  const failed = await run(['bring-over'], down);
  assert.equal(failed.code, 1);
  assert.deepEqual(down.state.writes, []);

  const locked = await run(['bring-over'], backend({ down: 402 }));
  assert.equal(locked.code, 1);
  assert.match(locked.err, /nexus\.atris\.ai/);
});

test('an empty store with people in the saved list points at bring-over, and never brings anything over by itself', async () => {
  const data = seed();
  data.people = [];
  const server = backend({ data });
  const { code, out, err } = await run([], server);
  assert.equal(code, 0);
  assert.match(out, /Nothing is waiting on you today\./);
  assert.equal(err, 'Your people store is empty, but your saved list has people. Run: atris nexus bring-over');
  assert.ok(!storeCalls(server).includes('POST /nexus/import'));
  assert.deepEqual(server.state.writes, []);

  const found = await run(['find', 'cy'], backend({ data }));
  assert.match(found.err, /atris nexus bring-over/);
  const named = await run(['Cy Placeholder'], backend({ data }));
  assert.equal(named.code, 1);
  assert.match(named.err, /atris nexus bring-over/);

  // No people in the saved list either, or people in the store: no line.
  const quiet = await run([], backend({ data, file: JSON.stringify({ nodes: [{ t: 'p', n: 'You', me: 1, d: 0 }], edges: [] }) }));
  assert.equal(quiet.err, '');
  const full = await run(['find', 'nobody'], backend());
  assert.equal(full.err, '');
});

test('no stored login stops before any call, and help lists the new commands', async () => {
  const server = backend();
  const out = [];
  const code = await nexusCommand(['wall', '--json'], { log: (l) => out.push(l), err: () => {}, getToken: async () => ({ token: '' }), apiRequestJson: server.request });
  assert.equal(code, 1);
  assert.deepEqual(server.state.calls, []);

  const help = await run(['--help'], server);
  for (const word of ['wall', 'goal', 'due', 'paid', 'city', 'bring-over', 'Only checked money counts']) assert.match(help.out, new RegExp(word));
  assert.deepEqual(server.state.calls, []);
});

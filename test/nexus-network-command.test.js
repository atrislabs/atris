'use strict';

// atris nexus groups, group, network, lists and save, with every backend call faked from the
// written contract (the backend routes were not live when this was written). Not run against a
// live backend. Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');

const NOW = new Date(2026, 10, 16, 12);
const RAE = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const CY = '33333333-3333-4333-8333-333333333333';
const DI = '44444444-4444-4444-8444-444444444444';
const ED = '55555555-5555-4555-8555-555555555555';
const FI = '66666666-6666-4666-8666-666666666666';
const STRANGER = '99999999-9999-4999-8999-999999999999';
const LIST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LIST_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NEWER = 'This needs a newer Atris. Try again after the next update.';
const PAUSED = 'The people store is paused for a few minutes. Nothing was saved. Try again shortly.';
const DUPLICATE = 'You already have a list with that name.';

const person = (id, name, title, company, stage, knows) => ({ id, name, title, company, stage, knows, last_touch_at: null });

function seed() {
  const sampleCo = [
    person(RAE, 'Rae Sample', 'Founder', 'Sample Co', 'replied', 2),
    person(BO, 'Bo Example', null, 'Sample Co', 'found', 1),
    person(CY, 'Cy Placeholder', 'Designer', null, 'reached_out', 1),
  ];
  const bigCo = [RAE, BO, CY, DI, ED].map((id, i) => person(id, `Person ${i + 1}`, null, 'Big Co', 'met', 5 - i));
  return {
    groups: {
      kinds: [
        { kind: 'saved', groups: [{ key: LIST_A, label: 'Austin founders', count: 3 }, { key: LIST_B, label: 'Founders', count: 2 }, { key: LIST_C, label: 'founders', count: 1 }] },
        { kind: 'list', groups: [{ key: 'investors', label: 'Investors', count: 4 }] },
        { kind: 'company', groups: [{ key: 'sample co', label: 'Sample Co', count: 3 }, { key: 'example inc', label: 'Example Inc', count: 2 }, { key: 'big co', label: 'Big Co', count: 5 }] },
        { kind: 'city', groups: [{ key: 'austin', label: 'Austin', count: 4 }] },
        { kind: 'cluster', groups: [{ key: `c-${RAE}`, label: 'Around Rae Sample', count: 3 }, { key: `c-${DI}`, label: 'Around Rae Sample', count: 2 }] },
      ],
    },
    opens: {
      'company|sample co': {
        group: { kind: 'company', key: 'sample co', label: 'Sample Co', count: 3 },
        most_connected: { person_id: RAE, name: 'Rae Sample', knows: 2 },
        way_in: { person_id: BO, name: 'Bo Example', closeness: 1, last_touch_at: '2026-11-10T09:00:00+00:00' },
        talking: 1,
        in_common: [{ label: 'Founders', count: 3 }, { label: 'Austin', count: 2 }],
        people: sampleCo,
        links: [{ a: RAE, b: BO }, { a: RAE, b: CY }],
        links_total: 2,
      },
      'company|example inc': {
        group: { kind: 'company', key: 'example inc', label: 'Example Inc', count: 2 },
        most_connected: { person_id: DI, name: 'Di Four', knows: 1 }, way_in: null, talking: 0, in_common: [], people: [person(DI, 'Di Four', null, 'Example Inc', 'met', 1), person(ED, 'Ed Five', null, 'Example Inc', 'met', 1)], links: [], links_total: 0,
      },
      'company|big co': {
        group: { kind: 'company', key: 'big co', label: 'Big Co', count: 5 },
        most_connected: { person_id: RAE, name: 'Person 1', knows: 5 },
        way_in: null,
        talking: 0,
        in_common: [],
        people: bigCo,
        links: [],
        links_total: 0,
      },
      'company|solo llc': {
        group: { kind: 'company', key: 'solo llc', label: 'Solo LLC', count: 1 },
        most_connected: null,
        way_in: null,
        talking: 0,
        in_common: [],
        people: [person(FI, 'Fi Solo', 'Owner', 'Solo LLC', 'found', 0)],
        links: [],
        links_total: 0,
      },
      [`saved|${LIST_A}`]: {
        group: { kind: 'saved', key: LIST_A, label: 'Austin founders', count: 3 },
        most_connected: null, way_in: null, talking: 0, in_common: [], people: sampleCo, links: [], links_total: 0,
      },
      [`cluster|c-${RAE}`]: {
        group: { kind: 'cluster', key: `c-${RAE}`, label: 'Around Rae Sample', count: 3 },
        most_connected: { person_id: RAE, name: 'Rae Sample', knows: 2 }, way_in: null, talking: 0, in_common: [], people: sampleCo, links: [], links_total: 0,
      },
    },
    network: {
      people: 1090,
      linked_people: 261,
      links: 467,
      clusters: [{ key: `c-${RAE}`, label: 'Sample Co', count: 14 }, { key: `c-${DI}`, label: 'Around Di Four', count: 6 }],
      most_connected: [{ person_id: RAE, name: 'Rae Sample', knows: 12 }, { person_id: BO, name: 'Bo Example', knows: 9 }],
      bridges: [{ person_id: CY, name: 'Cy Placeholder', joins: 3 }, { person_id: DI, name: 'Di Four', joins: 1 }],
    },
    lists: [
      { id: LIST_A, name: 'Austin founders', count: 3, made_by: 'me', created_at: '2026-11-14T10:00:00+00:00' },
      { id: LIST_B, name: 'Founders', count: 2, made_by: 'helper', created_at: '2026-11-15T10:00:00+00:00' },
      { id: LIST_C, name: 'founders', count: 1, made_by: 'me', created_at: '2026-11-15T11:00:00+00:00' },
    ],
    known: new Set([RAE, BO, CY, DI, ED, FI]),
  };
}

// A stand-in for the backend, from the written contract. `down` makes every /nexus call fail with
// that status. `fail` makes one route fail. Any call to the saved-list file is recorded, and tests
// assert there is none.
function backend({ data = seed(), down = null, fail = {} } = {}) {
  const state = { calls: [], data, refs: new Map(), made: 0, searches: [] };
  // A copy, as a real answer is: a caller holding an old answer never sees the store change under it.
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, data: body === undefined ? body : JSON.parse(JSON.stringify(body)), error: body && body.detail });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body, options });
    if (url.pathname.startsWith('/memory/')) return answer(404, { detail: 'No file at files/people.json' });
    if (down === 0) return { ok: false, status: 0, data: null, error: 'ECONNREFUSED' };
    if (down) return answer(down, { detail: down === 404 ? 'Not Found' : 'down' });
    const key = `${method} ${url.pathname}`;
    if (fail[key]) return answer(fail[key], { detail: 'failed' });
    const d = state.data;
    let m;

    if (key === 'GET /nexus/groups') return answer(200, d.groups);
    if (key === 'POST /nexus/groups/open') {
      const open = d.opens[`${options.body.kind}|${options.body.key}`];
      if (!open) return answer(404, { detail: 'No such group.' });
      const start = Number(options.body.cursor || 0);
      const limit = Number(options.body.limit);
      const people = open.people.slice(start, start + limit);
      const next = start + limit < open.people.length ? String(start + limit) : null;
      return answer(200, { ...open, people, next_cursor: next, links: start === 0 ? open.links : [] });
    }
    if (key === 'GET /nexus/network') return answer(200, d.network);
    if (key === 'GET /nexus/lists') return answer(200, { lists: d.lists });
    if (key === 'POST /nexus/lists') {
      const body = options.body;
      if (state.refs.has(body.ref)) return answer(200, { ...state.refs.get(body.ref), replayed: true });
      if (d.lists.some((l) => l.name === body.name)) return answer(409, { detail: 'A list with that name already exists.' });
      let ids = body.person_ids;
      if (body.from) {
        const open = d.opens[`${body.from.kind}|${body.from.key}`];
        if (!open) return answer(404, { detail: 'No such group.' });
        ids = open.people.map((p) => p.id);
      }
      const own = ids.filter((id) => d.known.has(id));
      const list = { id: `eeeeeeee-eeee-4eee-8eee-${String(++state.made).padStart(12, '0')}`, name: body.name, count: own.length, made_by: body.made_by, created_at: '2026-11-16T12:00:00+00:00' };
      d.lists.push(list);
      d.members = d.members || {};
      d.members[list.id] = new Set(own);
      const result = { list: { id: list.id, name: list.name, count: list.count }, skipped: ids.length - own.length, replayed: false };
      state.refs.set(body.ref, result);
      return answer(200, result);
    }
    if ((m = /^POST \/nexus\/lists\/([^/]+)\/people$/.exec(key))) {
      const list = d.lists.find((l) => l.id === m[1]);
      if (!list) return answer(404, { detail: 'No such list.' });
      const members = (d.members = d.members || {})[list.id] || (d.members[list.id] = new Set());
      const skipped = [...options.body.add, ...options.body.remove].filter((id) => !d.known.has(id)).length;
      for (const id of options.body.add) if (d.known.has(id)) members.add(id);
      for (const id of options.body.remove) members.delete(id);
      list.count = members.size;
      return answer(200, { list: { id: list.id, name: list.name, count: list.count }, skipped });
    }
    if ((m = /^PATCH \/nexus\/lists\/([^/]+)$/.exec(key))) {
      const list = d.lists.find((l) => l.id === m[1]);
      if (!list) return answer(404, { detail: 'No such list.' });
      if (d.lists.some((l) => l.name === options.body.name && l !== list)) return answer(409, { detail: 'A list with that name already exists.' });
      list.name = options.body.name;
      return answer(200, { list: { id: list.id, name: list.name, count: list.count } });
    }
    if ((m = /^DELETE \/nexus\/lists\/([^/]+)$/.exec(key))) {
      const at = d.lists.findIndex((l) => l.id === m[1]);
      if (at < 0) return answer(404, { detail: 'No such list.' });
      d.lists.splice(at, 1);
      return answer(200, { deleted: true });
    }
    if (key === 'POST /nexus/people/search') {
      state.searches.push(options.body);
      return answer(200, { total: 1, limit: options.body.limit, offset: options.body.offset, people: [{ id: RAE, name: 'Rae Sample', company_name: 'Sample Co', private: { stage: 'replied', closeness: 1 } }] });
    }
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
    newRef: () => REF,
    readStdin: async () => null,
    ...deps,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

const calls = (server) => server.state.calls.map((c) => `${c.method} ${c.path}`);
const fileCalls = (server) => server.state.calls.filter((c) => c.path.startsWith('/memory/'));
const opensOf = (server) => server.state.calls.filter((c) => c.path === '/nexus/groups/open');

// ---- groups ----

test('groups prints a plain heading per kind, with a label and a count on each line', async () => {
  const { code, out, err, server } = await run(['groups']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.deepEqual(out.split('\n'), [
    'Saved lists',
    '  Austin founders  3',
    '  Founders         2',
    '  founders         1',
    '',
    'Lists',
    '  Investors  4',
    '',
    'Companies',
    '  Sample Co    3',
    '  Example Inc  2',
    '  Big Co       5',
    '',
    'Cities',
    '  Austin  4',
    '',
    'Clusters',
    '  Around Rae Sample  3',
    '  Around Rae Sample  2',
  ]);
  assert.deepEqual(calls(server), ['GET /nexus/groups']);
});

test('groups --kind shows one kind; an unknown kind is refused before any call', async () => {
  const one = await run(['groups', '--kind', 'company']);
  assert.equal(one.code, 0);
  assert.match(one.out, /^Companies\n/);
  assert.ok(!one.out.includes('Cities'));
  assert.ok(!one.out.includes('Saved lists'));

  const upper = await run(['groups', '--kind=CITY']);
  assert.equal(upper.out.split('\n')[0], 'Cities');

  const none = await run(['groups', '--kind', 'school']);
  assert.equal(none.code, 0);
  assert.equal(none.out, 'No schools yet.');

  const wrong = await run(['groups', '--kind', 'planet']);
  assert.equal(wrong.code, 2);
  assert.equal(wrong.out, '');
  assert.equal(wrong.err, '"planet" is not a kind of group. Use saved, list, company, city, school, cluster.');
  assert.deepEqual(wrong.server.state.calls, []);

  const empty = await run(['groups'], backend({ data: { ...seed(), groups: { kinds: [] } } }));
  assert.equal(empty.code, 0);
  assert.match(empty.out, /^No groups yet\./);
});

test('groups --json prints the store\'s answer, narrowed to the kind when one is asked for', async () => {
  const data = seed();
  const all = await run(['groups', '--json'], backend({ data }));
  assert.equal(all.out, JSON.stringify(data.groups));
  const one = await run(['groups', '--kind', 'city', '--json']);
  assert.deepEqual(JSON.parse(one.out), { kinds: [data.groups.kinds.find((k) => k.kind === 'city')] });
  assert.equal(one.out.split('\n').length, 1, 'one JSON object, nothing else');
  assert.equal(one.err, '');
});

test('groups says when a heading is cut at the biggest fifty', async () => {
  const data = seed();
  data.groups = { kinds: [{ kind: 'company', groups: Array.from({ length: 50 }, (_, i) => ({ key: `co ${i}`, label: `Co ${i}`, count: 100 - i })) }] };
  const { out } = await run(['groups'], backend({ data }));
  assert.match(out, /Each heading shows its biggest 50\./);
});

// ---- group ----

test('group matches the exact key first, then the label in any case, and shows the group', async () => {
  const byKey = await run(['group', 'company', 'sample co']);
  assert.equal(byKey.code, 0);
  assert.deepEqual(byKey.out.split('\n'), [
    'Sample Co (company): 3 people',
    'Most connected: Rae Sample, knows 2',
    'Your way in: Bo Example (direct, last talked Nov 10)',
    'Talking: 1',
    'In common: Founders 3, Austin 2',
    '',
    '  Rae Sample      Founder at Sample Co  Replied      knows 2',
    '  Bo Example      Sample Co             Found        knows 1',
    '  Cy Placeholder  Designer              Reached out  knows 1',
  ]);
  assert.deepEqual(calls(byKey.server), ['GET /nexus/groups', 'POST /nexus/groups/open']);
  assert.deepEqual(opensOf(byKey.server)[0].body, { kind: 'company', key: 'sample co', limit: 50, cursor: null });

  const byLabel = await run(['group', 'company', 'SAMPLE CO']);
  assert.equal(byLabel.code, 0);
  assert.deepEqual(opensOf(byLabel.server)[0].body.key, 'sample co');

  const unquoted = await run(['group', 'company', 'Example', 'Inc']);
  assert.equal(unquoted.code, 0);
  assert.equal(opensOf(unquoted.server)[0].body.key, 'example inc');

  const saved = await run(['group', 'saved', 'austin founders']);
  assert.equal(opensOf(saved.server)[0].body.key, LIST_A, 'a saved list opens by its id');

  const keyOnly = await run(['group', 'saved', LIST_A]);
  assert.equal(opensOf(keyOnly.server)[0].body.key, LIST_A);
});

test('group shows none yet where the store has nothing to say', async () => {
  const { out } = await run(['group', 'company', 'Big Co']);
  const lines = out.split('\n');
  assert.equal(lines[1], 'Most connected: Person 1, knows 5');
  assert.equal(lines[2], 'Your way in: no one yet');
  assert.equal(lines[4], 'In common: nothing yet');
  const solo = await run(['group', 'company', 'Solo LLC']);
  assert.equal(solo.code, 0, 'a group the store did not list is opened by the key its words make');
  assert.equal(solo.out.split('\n')[1], 'Most connected: no ties yet');
  assert.equal(opensOf(solo.server)[0].body.key, 'solo llc');
});

test('group with two matching labels lists them with their keys and stops', async () => {
  const server = backend();
  const { code, out, err } = await run(['group', 'cluster', 'around rae sample'], server);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.deepEqual(err.split('\n'), [
    '2 groups match "around rae sample". Use the key to pick one.',
    `  Around Rae Sample  3 people  key: c-${RAE}`,
    `  Around Rae Sample  2 people  key: c-${DI}`,
  ]);
  assert.deepEqual(calls(server), ['GET /nexus/groups'], 'nothing is opened');

  const json = await run(['group', 'cluster', 'Around Rae Sample', '--json']);
  assert.equal(json.code, 1);
  assert.equal(json.err, '');
  const said = JSON.parse(json.out);
  assert.equal(said.ok, false);
  assert.equal(said.total, 2);
  assert.deepEqual(said.matches.map((x) => x.key), [`c-${RAE}`, `c-${DI}`]);

  const exact = await run(['group', 'cluster', `c-${DI}`], backend({ data: (() => {
    const d = seed();
    d.opens[`cluster|c-${DI}`] = { ...d.opens[`cluster|c-${RAE}`], group: { kind: 'cluster', key: `c-${DI}`, label: 'Around Rae Sample', count: 2 } };
    return d;
  })() }));
  assert.equal(exact.code, 0, 'the exact key picks one even when the labels match');
  assert.equal(opensOf(exact.server)[0].body.key, `c-${DI}`);
});

test('two saved lists whose names differ only in case are listed, not guessed', async () => {
  const { code, err } = await run(['group', 'saved', 'FOUNDERS']);
  assert.equal(code, 1);
  assert.match(err, /^2 groups match "FOUNDERS"/);
  assert.match(err, new RegExp(`Founders {2}2 people {2}key: ${LIST_B}`));
  assert.match(err, new RegExp(`founders {2}1 person {2}key: ${LIST_C}`));
});

test('group names what it cannot find, and a guessed key that the store does not know', async () => {
  const cluster = await run(['group', 'cluster', 'Nobody Here']);
  assert.equal(cluster.code, 1);
  assert.equal(cluster.err, 'No cluster called "Nobody Here" in your network.');
  assert.deepEqual(calls(cluster.server), ['GET /nexus/groups']);

  const company = await run(['group', 'company', 'Not A Company']);
  assert.equal(company.code, 1);
  assert.equal(company.err, 'No company called "Not A Company" in your network.');
  assert.deepEqual(calls(company.server), ['GET /nexus/groups', 'POST /nexus/groups/open']);

  const saved = await run(['group', 'saved', 'No Such List']);
  assert.equal(saved.code, 1);
  assert.equal(saved.err, 'No saved list called "No Such List". See them: atris nexus lists');

  const json = await run(['group', 'company', 'Not A Company', '--json']);
  assert.deepEqual(JSON.parse(json.out), { ok: false, error: 'No company called "Not A Company" in your network.' });
  assert.equal(json.code, 1);
});

test('group checks its words before any call', async () => {
  for (const [args, said] of [
    [['group'], /needs a kind and a label/],
    [['group', 'company'], /needs a kind and a label/],
    [['group', 'planet', 'X'], /"planet" is not a kind of group/],
    [['group', 'company', 'X', '--limit', '0'], /--limit takes a whole number from 1 to 200/],
    [['group', 'company', 'X', '--limit', '500'], /--limit takes a whole number from 1 to 200/],
    [['group', 'company', 'X', '--limit', 'ten'], /--limit takes a whole number/],
  ]) {
    const server = backend();
    const res = await run(args, server);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.err, said);
    assert.equal(res.err.split('\n').length, 1, 'one plain line');
    assert.deepEqual(server.state.calls, []);
  }
});

test('group --limit sets the page, and says how to see everyone when there is more', async () => {
  const server = backend();
  const { code, out } = await run(['group', 'company', 'Big Co', '--limit', '2'], server);
  assert.equal(code, 0);
  assert.equal(opensOf(server)[0].body.limit, 2);
  assert.match(out, /Big Co \(company\): 5 people/);
  assert.match(out, /Person 2/);
  assert.ok(!out.includes('Person 3'));
  assert.match(out, /Showing 2 of 5\. Add --all for everyone\.$/);
  assert.equal(opensOf(server).length, 1);

  const all = await run(['group', 'company', 'Sample Co']);
  assert.ok(!all.out.includes('Showing'), 'no footer when the page holds everyone');
});

test('group --all walks every page and keeps the first page\'s links', async () => {
  const server = backend();
  const { code, out } = await run(['group', 'company', 'Big Co', '--all', '--limit', '2'], server);
  assert.equal(code, 0);
  assert.deepEqual(opensOf(server).map((c) => [c.body.limit, c.body.cursor]), [[2, null], [2, '2'], [2, '4']]);
  for (const n of [1, 2, 3, 4, 5]) assert.match(out, new RegExp(`Person ${n}`));
  assert.ok(!out.includes('Showing'));

  const plain = backend();
  await run(['group', 'company', 'Big Co', '--all'], plain);
  assert.deepEqual(opensOf(plain).map((c) => [c.body.limit, c.body.cursor]), [[100, null]], 'the default page for --all is 100');

  const json = await run(['group', 'company', 'Big Co', '--all', '--limit', '2', '--json']);
  const said = JSON.parse(json.out);
  assert.equal(said.people.length, 5);
  assert.equal(said.next_cursor, null);
  assert.equal(said.group.count, 5);
  assert.equal(json.out.split('\n').length, 1);

  const links = seed();
  links.opens['company|big co'].links = [{ a: RAE, b: BO }];
  links.opens['company|big co'].links_total = 1;
  const withLinks = JSON.parse((await run(['group', 'company', 'Big Co', '--all', '--limit', '2', '--json'], backend({ data: links }))).out);
  assert.deepEqual(withLinks.links, [{ a: RAE, b: BO }]);
  assert.equal(withLinks.links_total, 1);
});

test('group --all stops on a store whose cursor never moves', async () => {
  const data = seed();
  const base = backend({ data });
  const request = async (pathname, options = {}) => {
    const res = await base.request(pathname, options);
    if (pathname === '/nexus/groups/open') res.data = { ...res.data, next_cursor: 'stuck' };
    return res;
  };
  const { code } = await run(['group', 'company', 'Big Co', '--all', '--limit', '2'], { state: base.state, request });
  assert.equal(code, 0);
  assert.ok(opensOf(base).length <= 3, 'the same cursor is not followed twice');
});

// ---- network ----

test('network prints the numbers, then clusters, most connected and bridges', async () => {
  const { code, out, server } = await run(['network']);
  assert.equal(code, 0);
  assert.deepEqual(out.split('\n'), [
    'Your network',
    '  People         1090',
    '  Linked people   261',
    '  Links           467',
    '',
    'Clusters',
    '  Sample Co       14 people',
    '  Around Di Four   6 people',
    '',
    'Most connected',
    '  Rae Sample  knows 12',
    '  Bo Example   knows 9',
    '',
    'Bridges (without them the network splits)',
    '  Cy Placeholder  joins 3 parts',
    '  Di Four          joins 1 part',
  ]);
  assert.deepEqual(calls(server), ['GET /nexus/network']);

  const json = await run(['network', '--json']);
  assert.equal(json.out, JSON.stringify(seed().network));

  const data = seed();
  data.network = { people: 3, linked_people: 0, links: 0, clusters: [], most_connected: [], bridges: [] };
  const flat = await run(['network'], backend({ data }));
  assert.match(flat.out, /No ties yet, so there are no clusters or bridges to find\.$/);
  data.network = { people: 0, linked_people: 0, links: 0, clusters: [], most_connected: [], bridges: [] };
  assert.equal((await run(['network'], backend({ data }))).out, 'No one is on your list yet.');

  const extra = await run(['network', 'now']);
  assert.equal(extra.code, 2);
  assert.deepEqual(extra.server.state.calls, []);
});

// ---- lists ----

test('lists shows each saved list with its count, and who made it when a helper did', async () => {
  const { code, out, server } = await run(['lists']);
  assert.equal(code, 0);
  assert.deepEqual(out.split('\n'), [
    '3 saved lists.',
    '  Austin founders  3 people',
    '  Founders         2 people  made by a helper',
    '  founders         1 person',
  ]);
  assert.deepEqual(calls(server), ['GET /nexus/lists']);

  const json = await run(['lists', '--json']);
  assert.equal(json.out, JSON.stringify({ lists: seed().lists }));

  const data = seed();
  data.lists = [];
  const none = await run(['lists'], backend({ data }));
  assert.match(none.out, /^No saved lists yet\. Make one: atris nexus save/);
});

// ---- save ----

test('save --from reads the groups, then sends the key and made_by me, with one ref', async () => {
  const server = backend();
  const { code, out, err } = await run(['save', 'Sample crew', '--from', 'company', 'sample co'], server);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(out, 'Saved "Sample crew": 3 people, 0 skipped.');
  assert.deepEqual(calls(server), ['GET /nexus/groups', 'POST /nexus/lists']);
  assert.deepEqual(server.state.calls[1].body, { name: 'Sample crew', ref: REF, from: { kind: 'company', key: 'sample co' }, made_by: 'me' });

  // The label is matched to a key the same way group does it, in any case.
  const byLabel = backend();
  await run(['save', 'Big crew', '--from', 'company', 'BIG CO'], byLabel);
  assert.deepEqual(byLabel.state.calls[1].body.from, { kind: 'company', key: 'big co' });

  // --from=kind and the label may sit before the name.
  const early = backend();
  const res = await run(['save', '--from=company', 'Sample Co', 'Early crew'], early);
  assert.equal(res.code, 0);
  assert.equal(early.state.calls[1].body.name, 'Early crew');
  assert.equal(early.state.calls[1].body.from.key, 'sample co');

  // A saved list can be the source, by its name.
  const copy = backend();
  await run(['save', 'Copy', '--from', 'saved', 'Austin founders'], copy);
  assert.deepEqual(copy.state.calls[1].body.from, { kind: 'saved', key: LIST_A });
});

test('save --from stops on an unclear label and saves nothing', async () => {
  const server = backend();
  const { code, err } = await run(['save', 'Cluster crew', '--from', 'cluster', 'Around Rae Sample'], server);
  assert.equal(code, 1);
  assert.match(err, /^2 groups match "Around Rae Sample"/);
  assert.deepEqual(calls(server), ['GET /nexus/groups']);

  const missing = await run(['save', 'X', '--from', 'cluster', 'Nobody']);
  assert.equal(missing.code, 1);
  assert.equal(missing.err, 'No cluster called "Nobody" in your network.');
  assert.ok(!calls(missing.server).includes('POST /nexus/lists'));

  const gone = await run(['save', 'X', '--from', 'company', 'Not A Company']);
  assert.equal(gone.code, 1);
  assert.equal(gone.err, 'No company called "Not A Company" in your network.');
});

test('save --ids sends the ids once each, and says how many were skipped', async () => {
  const server = backend();
  const { code, out } = await run(['save', 'Hand picked', '--ids', `${RAE},${BO.toUpperCase()},${RAE},${STRANGER}`], server);
  assert.equal(code, 0);
  assert.equal(out, 'Saved "Hand picked": 2 people, 1 skipped.\nSkipped people are not on your list, so they were left out.');
  assert.deepEqual(calls(server), ['POST /nexus/lists']);
  assert.deepEqual(server.state.calls[0].body, { name: 'Hand picked', ref: REF, person_ids: [RAE, BO, STRANGER], made_by: 'me' });
  assert.ok(!('from' in server.state.calls[0].body), 'ids and from are never both sent');
});

test('save reads ids from standard input, one per line', async () => {
  const server = backend();
  const stdin = `${RAE}\r\n\n  ${CY}  \n${RAE}\n`;
  const { code, out } = await run(['save', 'Piped'], server, { readStdin: async () => stdin });
  assert.equal(code, 0);
  assert.equal(out, 'Saved "Piped": 2 people, 0 skipped.');
  assert.deepEqual(server.state.calls[0].body.person_ids, [RAE, CY]);

  const keyboard = await run(['save', 'Piped'], backend(), { readStdin: async () => null });
  assert.equal(keyboard.code, 2);
  assert.match(keyboard.err, /^Say who to save: --from <kind> "<label>", --ids id1,id2, or send person ids on standard input/);
  assert.deepEqual(keyboard.server.state.calls, []);

  const empty = await run(['save', 'Piped'], backend(), { readStdin: async () => '\n\n' });
  assert.equal(empty.code, 2);
  assert.equal(empty.err, 'No person ids were given.');
  assert.deepEqual(empty.server.state.calls, []);

  const junk = await run(['save', 'Piped'], backend(), { readStdin: async () => `${RAE}\nRae Sample\n` });
  assert.equal(junk.code, 2);
  assert.match(junk.err, /^"Rae Sample" is not a person id\./);
  assert.deepEqual(junk.server.state.calls, []);

  const ignored = backend();
  await run(['save', 'Flag wins', '--ids', RAE], ignored, { readStdin: async () => { throw new Error('stdin must not be read when --ids is given'); } });
  assert.deepEqual(ignored.state.calls[0].body.person_ids, [RAE]);
});

test('save --as-helper says a helper made it, and each run makes its own ref', async () => {
  const helper = backend();
  await run(['save', 'By helper', '--ids', RAE, '--as-helper'], helper);
  assert.equal(helper.state.calls[0].body.made_by, 'helper');

  // With no newRef given, the ref is a fresh uuid every run.
  const refs = [];
  for (let i = 0; i < 2; i++) {
    const server = backend();
    const out = [];
    await nexusCommand(['save', `Run ${i}`, '--ids', RAE], {
      log: (l) => out.push(l), err: () => {}, getToken: async () => ({ token: 'tok' }), apiRequestJson: server.request, now: () => NOW,
    });
    refs.push(server.state.calls[0].body.ref);
  }
  assert.match(refs[0], UUID);
  assert.match(refs[1], UUID);
  assert.notEqual(refs[0], refs[1]);
});

test('the same ref again is a replay: one list, said plainly', async () => {
  const server = backend();
  const first = await run(['save', 'Once', '--ids', RAE], server);
  const again = await run(['save', 'Once', '--ids', RAE], server);
  assert.equal(first.code, 0);
  assert.equal(again.code, 0);
  assert.match(again.out, /Saved "Once": 1 person, 0 skipped\.\nThis save had already gone through/);
  assert.equal(server.state.data.lists.filter((l) => l.name === 'Once').length, 1);
});

test('save --json prints the store\'s answer', async () => {
  const { code, out } = await run(['save', 'Json list', '--ids', RAE, '--json']);
  assert.equal(code, 0);
  const said = JSON.parse(out);
  assert.equal(said.list.name, 'Json list');
  assert.equal(said.list.count, 1);
  assert.equal(said.skipped, 0);
  assert.equal(said.replayed, false);
  assert.equal(out.split('\n').length, 1);
});

test('a duplicate list name says so in one plain line', async () => {
  for (const args of [['save', 'Founders', '--ids', RAE], ['lists', 'rename', 'Austin founders', 'Founders']]) {
    const { code, err, out } = await run(args);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out, '');
    assert.equal(err, DUPLICATE);
  }
  const json = await run(['save', 'Founders', '--ids', RAE, '--json']);
  assert.deepEqual(JSON.parse(json.out), { ok: false, error: DUPLICATE });
  assert.equal(json.code, 1);
});

test('save checks its words before any call', async () => {
  const long = 'x'.repeat(81);
  const tooMany = Array.from({ length: 5001 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`).join(',');
  for (const [args, said] of [
    [['save'], /needs one list name/],
    [['save', 'A', 'B', '--ids', RAE], /needs one list name, in quotes/],
    [['save', '   ', '--ids', RAE], /needs a name/],
    [['save', long, '--ids', RAE], /at most 80 characters/],
    [['save', 'X', '--from', 'company'], /--from needs a kind and a label/],
    [['save', 'X', '--from', 'company', '--json'], /--from needs a kind and a label/],
    [['save', 'X', '--from', 'planet', 'Y'], /"planet" is not a kind of group/],
    [['save', 'X', '--from', 'company', 'Y', '--ids', RAE], /Use only one of --from and --ids/],
    [['save', 'X', '--ids', 'Rae Sample'], /"Rae Sample" is not a person id/],
    [['save', 'X', '--ids', ''], /No person ids were given/],
    [['save', 'X', '--ids', tooMany], /at most 5000 people\. 5001 were given/],
  ]) {
    const server = backend();
    const res = await run(args, server);
    assert.equal(res.code, 2, args.join(' ').slice(0, 60));
    assert.match(res.err || res.out, said);
    assert.deepEqual(server.state.calls, []);
    if (!args.includes('--json')) assert.equal(res.err.split('\n').length, 1, 'one plain line');
  }
});

// ---- lists add, remove, rename, delete ----

test('lists add and remove find the list by name and send ids in the body', async () => {
  const added = backend();
  const a = await run(['lists', 'add', 'austin FOUNDERS', RAE, `${BO},${CY}`], added);
  assert.equal(a.code, 0);
  assert.equal(a.out, 'Added to "Austin founders". It has 3 people now.');
  assert.deepEqual(calls(added), ['GET /nexus/lists', `POST /nexus/lists/${LIST_A}/people`]);
  assert.deepEqual(added.state.calls[1].body, { add: [RAE, BO, CY], remove: [] });

  const removed = backend();
  const r = await run(['lists', 'remove', 'Austin founders', BO, STRANGER], removed);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Removed from "Austin founders". It has 0 people now, 1 skipped.');
  assert.deepEqual(removed.state.calls[1].body, { add: [], remove: [BO, STRANGER] });

  const json = await run(['lists', 'add', 'Austin founders', RAE, '--json']);
  assert.deepEqual(JSON.parse(json.out), { list: { id: LIST_A, name: 'Austin founders', count: 1 }, skipped: 0 });
});

test('lists rename and lists delete', async () => {
  const renamed = backend();
  const r = await run(['lists', 'rename', 'Austin founders', 'Texas founders'], renamed);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Renamed "Austin founders" to "Texas founders".');
  assert.deepEqual(calls(renamed), ['GET /nexus/lists', `PATCH /nexus/lists/${LIST_A}`]);
  assert.deepEqual(renamed.state.calls[1].body, { name: 'Texas founders' });

  const deleted = backend();
  const d = await run(['lists', 'delete', 'Austin founders', '--yes'], deleted);
  assert.equal(d.code, 0);
  assert.equal(d.out, 'Deleted the list "Austin founders". The people on it are still on your list.');
  assert.deepEqual(calls(deleted), ['GET /nexus/lists', `DELETE /nexus/lists/${LIST_A}`]);
  assert.equal(deleted.state.data.lists.length, 2);

  const json = await run(['lists', 'delete', 'Austin founders', '--yes', '--json']);
  assert.deepEqual(JSON.parse(json.out), { deleted: true });
});

test('lists delete refuses without --yes, and says it never removes the people', async () => {
  const server = backend();
  const { code, err, out } = await run(['lists', 'delete', 'Austin founders'], server);
  assert.equal(code, 2);
  assert.equal(out, '');
  assert.equal(err, 'This removes the list "Austin founders" and never the people in it. Run it again with --yes to go ahead.');
  assert.deepEqual(server.state.calls, [], 'nothing is read or sent');
  assert.equal(server.state.data.lists.length, 3);

  const json = await run(['lists', 'delete', 'Austin founders', '--json']);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.out).ok, false);
  assert.match(JSON.parse(json.out).error, /never the people/);
});

test('lists names what it cannot find, and lists two lists that match instead of guessing', async () => {
  const none = await run(['lists', 'add', 'No Such List', RAE]);
  assert.equal(none.code, 1);
  assert.equal(none.err, 'No saved list called "No Such List". See them: atris nexus lists');
  assert.deepEqual(calls(none.server), ['GET /nexus/lists']);

  // "Founders" and "founders" are two lists. The exact name is one; a third spelling matches both.
  const exact = await run(['lists', 'delete', 'Founders', '--yes']);
  assert.equal(exact.code, 0);
  assert.deepEqual(calls(exact.server).slice(-1), [`DELETE /nexus/lists/${LIST_B}`]);

  const both = await run(['lists', 'delete', 'FOUNDERS', '--yes']);
  assert.equal(both.code, 1);
  assert.match(both.err, /^2 saved lists match "FOUNDERS"/);
  assert.ok(!calls(both.server).some((c) => c.startsWith('DELETE')));
});

test('lists checks its words before any call', async () => {
  const long = 'x'.repeat(81);
  for (const [args, said] of [
    [['lists', 'add'], /lists add needs a list name and person ids/],
    [['lists', 'add', 'X'], /lists add needs a list name and person ids/],
    [['lists', 'remove', 'X'], /lists remove needs a list name and person ids/],
    [['lists', 'add', 'X', 'Rae Sample'], /"Rae Sample" is not a person id/],
    [['lists', 'rename', 'X'], /lists rename needs the old name and the new name/],
    [['lists', 'rename', 'X', long], /at most 80 characters/],
    [['lists', 'delete'], /lists delete needs one list name/],
    [['lists', 'frobnicate'], /lists takes add, remove, rename or delete/],
  ]) {
    const server = backend();
    const res = await run(args, server);
    assert.equal(res.code, 2, args.join(' '));
    assert.match(res.err, said);
    assert.equal(res.err.split('\n').length, 1, 'one plain line');
    assert.deepEqual(server.state.calls, []);
  }
});

// ---- search --list ----

test('search --list resolves the saved list name to its id and sends list_id in the body', async () => {
  const server = backend();
  const { code, out } = await run(['search', 'rae', '--list', 'austin founders'], server);
  assert.equal(code, 0);
  assert.match(out, /1 person matches "rae" \(in saved list "austin founders"\)\./);
  assert.deepEqual(calls(server), ['GET /nexus/lists', 'POST /nexus/people/search']);
  assert.deepEqual(server.state.searches[0], { limit: 25, offset: 0, q: 'rae', list_id: LIST_A });
  assert.ok(!('list' in server.state.searches[0]), 'the name itself is not sent');

  // It joins the other filters, and works on list and find too.
  const mixed = backend();
  await run(['find', 'rae', '--list', 'Austin founders', '--stage', 'replied', '--group', 'Investors'], mixed);
  assert.deepEqual(mixed.state.searches[0], { limit: 25, offset: 0, q: 'rae', group: 'Investors', stage: 'replied', list_id: LIST_A });
  const plainList = backend();
  const listed = await run(['list', '--list', 'Austin founders'], plainList);
  assert.equal(listed.code, 0);
  assert.equal(plainList.state.searches[0].list_id, LIST_A);

  const json = await run(['search', 'rae', '--list', 'Austin founders', '--json']);
  assert.equal(JSON.parse(json.out).total, 1);
});

test('search --list stops on an unknown or unclear list name, and on an empty one', async () => {
  const none = await run(['search', 'rae', '--list', 'No Such List']);
  assert.equal(none.code, 1);
  assert.equal(none.err, 'No saved list called "No Such List". See them: atris nexus lists');
  assert.deepEqual(none.server.state.searches, []);

  const both = await run(['search', 'rae', '--list', 'FOUNDERS']);
  assert.equal(both.code, 1);
  assert.match(both.err, /^2 saved lists match "FOUNDERS"/);
  assert.deepEqual(both.server.state.searches, []);

  const empty = await run(['search', 'rae', '--list', '']);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /--list needs the name of a saved list/);
  assert.deepEqual(empty.server.state.calls, []);
});

test('search --list never falls back to the saved list file', async () => {
  for (const down of [0, 500, 502]) {
    const server = backend({ down });
    const { code, err, out } = await run(['search', 'rae', '--list', 'Austin founders'], server);
    assert.equal(code, 1, `down ${down}`);
    assert.equal(out, '');
    assert.equal(err, 'The people store did not answer. Try again in a moment.');
    assert.deepEqual(fileCalls(server), []);
  }
  const old = await run(['search', 'rae', '--list', 'Austin founders'], backend({ down: 404 }));
  assert.equal(old.code, 1);
  assert.equal(old.err, NEWER, 'a backend with no saved lists never gets a search that would ignore the list');
  assert.deepEqual(fileCalls(old.server), []);
  assert.deepEqual(old.server.state.searches, []);

  // The search itself failing after the list was found is the store being down, not a fallback.
  const searchDown = backend({ fail: { 'POST /nexus/people/search': 500 } });
  const res = await run(['search', 'rae', '--list', 'Austin founders'], searchDown);
  assert.equal(res.code, 1);
  assert.equal(res.err, 'The people store did not answer, and --list needs it. Try again in a moment.');
  assert.deepEqual(fileCalls(searchDown), []);

  const noStore = await run(['search', 'rae', '--list', 'Austin founders'], backend(), { useStore: false });
  assert.equal(noStore.code, 1);
  assert.match(noStore.err, /--list needs it/);
});

// ---- the three error answers, on every command ----

const EVERY_COMMAND = [
  ['groups'],
  ['group', 'company', 'Sample Co'],
  ['network'],
  ['lists'],
  ['lists', 'add', 'Austin founders', RAE],
  ['lists', 'remove', 'Austin founders', RAE],
  ['lists', 'rename', 'Austin founders', 'Texas founders'],
  ['lists', 'delete', 'Austin founders', '--yes'],
  ['save', 'Brand new', '--ids', RAE],
  ['save', 'Brand new', '--from', 'company', 'Sample Co'],
  ['search', 'rae', '--list', 'Austin founders'],
];

test('a 404 says the store needs an update, exits non-zero, and never uses the saved list', async () => {
  for (const args of EVERY_COMMAND) {
    const server = backend({ down: 404 });
    const { code, out, err } = await run(args, server);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out, '', args.join(' '));
    assert.equal(err, NEWER, args.join(' '));
    assert.deepEqual(fileCalls(server), [], `${args.join(' ')} never touches the saved list`);
    assert.equal(server.state.calls.length, 1, `${args.join(' ')} stops at the first answer`);

    const json = await run([...args, '--json'], backend({ down: 404 }));
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.out), { ok: false, error: NEWER });
    assert.equal(json.err, '');
  }
});

test('a 503 prints the paused line and stops', async () => {
  for (const args of EVERY_COMMAND) {
    const server = backend({ down: 503 });
    const { code, out, err } = await run(args, server);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out, '');
    assert.equal(err, PAUSED, args.join(' '));
    assert.deepEqual(fileCalls(server), []);
  }
  // A write that is paused after the lists were read also stops there.
  const server = backend({ fail: { [`POST /nexus/lists/${LIST_A}/people`]: 503 } });
  const res = await run(['lists', 'add', 'Austin founders', RAE], server);
  assert.equal(res.code, 1);
  assert.equal(res.err, PAUSED);
});

test('an unreachable or failing store, 401 and 402 each stop with one plain line', async () => {
  for (const args of EVERY_COMMAND) {
    const server = backend({ down: 0 });
    const gone = await run(args, server);
    assert.equal(gone.code, 1, args.join(' '));
    // A change that never got an answer says it may not have saved; everything else read first.
    const first = server.state.calls[0];
    assert.equal(gone.err, first.method === 'GET' ? 'The people store did not answer. Try again in a moment.' : 'That did not save. Try again in a moment.', args.join(' '));
    assert.deepEqual(fileCalls(server), []);

    const locked = await run(args, backend({ down: 402 }));
    assert.equal(locked.code, 1);
    assert.equal(locked.err, 'Nexus needs a paid plan. Get it at https://nexus.atris.ai');

    const signedOut = await run(args, backend({ down: 401 }));
    assert.equal(signedOut.code, 1);
    assert.match(signedOut.err, /^Sign in to see your people\. not logged in\. run: atris login$/);
  }
  const locked = await run(['groups', '--json'], backend({ down: 402 }));
  assert.deepEqual(JSON.parse(locked.out), { ok: false, error: 'Nexus needs a paid plan. Get it at https://nexus.atris.ai', status: 402 });

  const writeLost = await run(['lists', 'delete', 'Austin founders', '--yes'], backend({ fail: { [`DELETE /nexus/lists/${LIST_A}`]: 500 } }));
  assert.equal(writeLost.err, 'That did not save. Try again in a moment.');
  assert.equal(writeLost.code, 1);
});

test('after the store has answered, a 404 means the group or list itself is gone', async () => {
  const server = backend({ fail: { [`DELETE /nexus/lists/${LIST_A}`]: 404 } });
  const { code, err } = await run(['lists', 'delete', 'Austin founders', '--yes'], server);
  assert.equal(code, 1);
  assert.equal(err, 'The saved list "Austin founders" is gone. See your lists: atris nexus lists');
});

test('a no-answer from the sign-in stops before any call', async () => {
  const server = backend();
  const out = [];
  const code = await nexusCommand(['groups', '--json'], { log: (l) => out.push(l), err: () => {}, getToken: async () => ({ token: '' }), apiRequestJson: server.request });
  assert.equal(code, 1);
  assert.deepEqual(server.state.calls, []);
});

// ---- no label or name in any address ----

test('no network command ever puts a label, list name, search word or name in a web address', async () => {
  const label = 'Zyxw Secretlabel';
  const listName = 'Qwerty Listname';
  const secrets = ['zyxw', 'secretlabel', 'qwerty', 'listname'];
  const known = () => {
    const data = seed();
    data.lists.push({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: listName, count: 1, made_by: 'me', created_at: '2026-11-16T10:00:00+00:00' });
    data.groups.kinds[2].groups.push({ key: 'zyxw secretlabel', label, count: 2 });
    data.groups.kinds[0].groups.push({ key: 'ffffffff-ffff-4fff-8fff-ffffffffffff', label: listName, count: 1 });
    data.opens['company|zyxw secretlabel'] = { ...data.opens['company|sample co'], group: { kind: 'company', key: 'zyxw secretlabel', label, count: 2 } };
    data.opens['saved|ffffffff-ffff-4fff-8fff-ffffffffffff'] = { ...data.opens['company|sample co'], group: { kind: 'saved', key: 'ffffffff-ffff-4fff-8fff-ffffffffffff', label: listName, count: 1 } };
    return backend({ data });
  };
  const everything = [
    ['groups'],
    ['groups', '--kind', 'company'],
    ['group', 'company', label],
    ['group', 'company', 'Zyxw Unknownlabel'],
    ['group', 'cluster', label],
    ['group', 'saved', listName],
    ['group', 'saved', 'Zyxw Unknownlist'],
    ['group', 'company', label, '--all', '--limit', '1'],
    ['network'],
    ['lists'],
    ['save', listName, '--from', 'company', label],
    ['save', 'Zyxw Newlist', '--from', 'saved', listName],
    ['save', 'Zyxw Newlist', '--ids', RAE],
    ['lists', 'add', listName, RAE],
    ['lists', 'remove', listName, RAE],
    ['lists', 'rename', listName, 'Zyxw Renamed'],
    ['lists', 'delete', listName, '--yes'],
    ['lists', 'delete', 'Zyxw Unknownlist', '--yes'],
    ['search', label, '--list', listName],
    ['find', label, '--list', listName, '--group', label],
    ['list', '--list', listName],
    ['search', label, '--list', 'Zyxw Unknownlist'],
  ];
  let sentInBodies = 0;
  for (const args of everything) {
    for (const extra of [[], ['--json']]) {
      const server = known();
      await run([...args, ...extra], server, { readStdin: async () => `${RAE}\n` });
      const asked = server.state.calls.filter((c) => c.path.startsWith('/nexus/'));
      assert.ok(asked.length > 0 || args[0] === 'groups', `${args.join(' ')} made a call`);
      for (const call of asked) {
        const address = `${call.path}?${new URLSearchParams(call.query)}`.toLowerCase();
        for (const part of [...secrets, 'zyxw renamed', 'newlist', 'unknownlist', 'unknownlabel']) {
          assert.ok(!address.includes(part), `${args.join(' ')} sent "${part}" in ${call.method} ${address}`);
        }
        // Only a saved list's own id, which the store handed over, may be in a path.
        for (const piece of call.path.split('/').slice(2)) {
          if (/^[0-9a-f]{8}-/.test(piece)) assert.match(piece, UUID);
          else assert.ok(['groups', 'open', 'network', 'lists', 'people', 'search'].includes(piece), `${args.join(' ')} sent an unexpected path piece "${piece}"`);
        }
        if (call.body && JSON.stringify(call.body).toLowerCase().match(/zyxw|secretlabel|qwerty|listname/)) sentInBodies++;
      }
    }
  }
  assert.ok(sentInBodies > 10, 'the labels do travel, in request bodies');
});

// ---- everything that already worked still does ----

test('a person whose name looks like a new command is still reachable', async () => {
  const people = [
    { id: RAE, is_public: false, mine: true, name: 'Network', title: null, company_name: null, location_raw: null, place: null, private: { stage: 'found', closeness: 1 } },
    { id: BO, is_public: false, mine: true, name: 'Group Smith', title: null, company_name: null, location_raw: null, place: null, private: { stage: 'found', closeness: 1 } },
  ];
  const base = backend();
  const request = async (pathname, options = {}) => {
    const url = new URL(pathname, 'https://x.test');
    if (url.pathname === '/nexus/people/search') {
      const q = String(options.body.q || '').toLowerCase();
      const hits = people.filter((p) => p.name.toLowerCase().includes(q));
      return { ok: true, status: 200, data: { total: hits.length, limit: 25, offset: 0, people: hits } };
    }
    if (url.pathname.startsWith('/nexus/people/')) {
      const card = people.find((p) => url.pathname.endsWith(p.id));
      return { ok: true, status: 200, data: { card, ties: [], touches: [] } };
    }
    return base.request(pathname, options);
  };
  // Capital letters or a full name in one word of its own are a name, not a command.
  for (const [word, name] of [['Network', 'Network'], ['Group Smith', 'Group Smith']]) {
    const res = await run([word], { state: base.state, request });
    assert.equal(res.code, 0, word);
    assert.equal(res.out.split('\n')[0], name);
  }
  assert.ok(!base.state.calls.some((c) => c.path === '/nexus/network' || c.path === '/nexus/groups'));
});

test('the old commands and their help are untouched, and help lists every new command', async () => {
  const server = backend();
  const help = await run(['--help'], server);
  for (const word of [
    'atris nexus groups', 'atris nexus group <kind>', 'atris nexus network', 'atris nexus lists ', 'atris nexus save "<list name>" --from', '--ids', '--as-helper',
    'lists add', 'lists remove', 'lists rename', 'lists delete', '--yes', 'never the people', '--list "<saved list>"',
    'atris nexus list ', 'atris nexus search', 'bring-over', 'Only checked money counts',
  ]) assert.ok(help.out.includes(word), `help names ${word}`);
  assert.deepEqual(server.state.calls, []);
  const sameWords = await run(['help'], backend());
  assert.equal(sameWords.out, help.out);
});

test('standard input is read to the end, and a keyboard is left alone', async () => {
  const { PassThrough } = require('node:stream');
  const { readStdin } = require('../commands/nexus-network');
  const piped = new PassThrough();
  const reading = readStdin(piped);
  piped.write(`${RAE}\n`);
  piped.end(`${BO}\n`);
  assert.equal(await reading, `${RAE}\n${BO}\n`);

  const keyboard = new PassThrough();
  keyboard.isTTY = true;
  assert.equal(await readStdin(keyboard), null);
});

test('the network commands need the store: with it switched off they say so and call nothing', async () => {
  for (const args of [['groups'], ['group', 'company', 'X'], ['network'], ['lists'], ['save', 'X', '--ids', RAE]]) {
    const server = backend();
    const { code, err } = await run(args, server, { useStore: false });
    assert.equal(code, 1, args.join(' '));
    assert.equal(err, 'The people store did not answer, and this command needs it. Try again in a moment.');
    assert.deepEqual(server.state.calls, []);
  }
});

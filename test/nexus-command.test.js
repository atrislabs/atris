'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');

const NOW = new Date(2026, 10, 14, 12);
const FILE = 'files/people.json';

function sample(extra = {}) {
  return {
    nodes: [
      { t: 'p', n: 'You', me: 1, d: 0 },
      { t: 'p', n: 'Jacob Effron', d: 1, status: 'met', last: '2026-11-13', title: 'Partner', co: 'Redpoint', mail: 1 },
      { t: 'p', n: 'Dylan Patel', d: 2, title: 'Founder', co: 'SemiAnalysis', x: { via: 'Jacob Effron' }, note: 'Writes about chips.', links: ['https://www.semianalysis.com/about', 'mailto:x'], act: [['2026-11-03', 'Email sent', 'hello']] },
      { t: 'p', n: 'Dylan Field', d: 1, status: 'replied', last: '2026-11-01', co: 'Figma' },
      { t: 'o', n: 'SemiAnalysis' },
      { t: 'l', n: 'San Francisco' },
    ],
    edges: [[0, 1, 'knows'], [1, 2, 'knows'], [0, 3, 'knows'], [2, 4, 'works at'], [2, 5, 'lives in']],
    ...extra,
  };
}

// A stand-in for the two server calls, keeping the file as text.
function fakeServer({ text = JSON.stringify(sample()), readFail = null, onRead = null } = {}) {
  const state = { text, calls: [], writes: [] };
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    state.calls.push(`${options.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/memory/file') {
      assert.equal(url.searchParams.get('path'), FILE);
      if (onRead) onRead(state);
      if (readFail) return { ok: false, status: readFail.status, data: { detail: readFail.error }, error: readFail.error };
      if (state.text === null) return { ok: false, status: 400, data: { detail: `No file at ${FILE}` }, error: `No file at ${FILE}` };
      return { ok: true, status: 200, data: { text: state.text } };
    }
    if (url.pathname === '/memory/write') {
      assert.equal(options.method, 'PUT');
      assert.equal(options.body.path, FILE);
      state.writes.push(options.body.text);
      state.text = options.body.text;
      return { ok: true, status: 200, data: {} };
    }
    throw new Error(`unexpected call ${pathname}`);
  };
  return { state, request };
}

async function run(args, server = fakeServer()) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server.request,
    now: () => NOW,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

test('one person by exact name, any case, with path, recent rows, ties and links', async () => {
  const { code, out } = await run(['dylan patel']);
  assert.equal(code, 0);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Dylan Patel');
  assert.equal(lines[1], 'Founder · SemiAnalysis · San Francisco');
  assert.match(out, /Closeness: One intro/);
  assert.match(out, /Stage: Found/);
  assert.match(out, /Next: Ask Jacob Effron for an intro\./);
  assert.match(out, /Way in: You → Jacob Effron → Dylan Patel/);
  assert.match(out, /No email yet/);
  assert.match(out, /Nov 3\s+Email sent  hello/);
  assert.match(out, /Writes about chips\./);
  assert.match(out, /Ties: Jacob Effron, SemiAnalysis/);
  assert.match(out, /Links: semianalysis\.com$/m);
  assert.doesNotMatch(out, /tok/);
});

test('a unique part of a name finds the person', async () => {
  const { code, out } = await run(['effron']);
  assert.equal(code, 0);
  assert.equal(out.split('\n')[0], 'Jacob Effron');
});

test('several matches list the names and exit 1', async () => {
  const { code, err, out } = await run(['dylan']);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /2 people match "dylan"/);
  assert.match(err, /Dylan Patel/);
  assert.match(err, /Dylan Field/);

  const json = await run(['dylan', '--json']);
  assert.equal(json.code, 1);
  const body = JSON.parse(json.out);
  assert.equal(body.ok, false);
  assert.deepEqual(body.matches.sort(), ['Dylan Field', 'Dylan Patel']);
});

test('no match exits 1', async () => {
  const { code, err } = await run(['Nobody Here']);
  assert.equal(code, 1);
  assert.match(err, /No one called "Nobody Here"/);
});

test('today lists the moves and the counts, and --json gives one object', async () => {
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.match(out, /^Today/);
  assert.match(out, /Dylan Field: Wrote back\. Answer them\./);
  assert.match(out, /Dylan Patel: One intro away, through Jacob Effron\./);
  assert.match(out, /3 people, 2 talking, 1 warm, 0 paying\./);

  const json = await run(['--json']);
  const body = JSON.parse(json.out);
  assert.equal(body.ok, true);
  assert.deepEqual(body.counts, { people: 3, talking: 2, warm: 1, paying: 0 });
  assert.deepEqual(Object.keys(body.today[0]).sort(), ['close', 'line', 'move', 'name', 'stage']);
  assert.equal(body.today[0].name, 'Dylan Field');
});

test('card --json has the card fields', async () => {
  const { code, out } = await run(['Dylan Patel', '--json']);
  assert.equal(code, 0);
  const { ok, person } = JSON.parse(out);
  assert.equal(ok, true);
  assert.equal(person.name, 'Dylan Patel');
  assert.equal(person.closeness, 'One intro');
  assert.equal(person.stage, 'Found');
  assert.equal(person.move, 'Ask Jacob Effron for an intro');
  assert.deepEqual(person.path, ['You', 'Jacob Effron', 'Dylan Patel']);
  assert.deepEqual(person.links, ['semianalysis.com']);
  assert.equal(person.recent[0].what, 'Email sent');
});

test('find searches title, company, city and status, best first, blanking generic moves', async () => {
  const text = JSON.stringify(sample({ nodes: [...sample().nodes, { t: 'p', n: 'Payer', d: 1, status: 'paying', co: 'Figma Pay' }] }));
  const { code, out } = await run(['find', 'figma', '--json'], fakeServer({ text }));
  assert.equal(code, 0);
  const body = JSON.parse(out);
  assert.equal(body.total, 2);
  assert.deepEqual(body.people.map((p) => p.name), ['Payer', 'Dylan Field']);
  assert.equal(body.people[0].move, '');
  assert.deepEqual(Object.keys(body.people[0]).sort(), ['close', 'company', 'move', 'name', 'stage']);

  const founders = await run(['find', 'founder']);
  assert.match(founders.out, /1 person matches "founder"/);
  assert.match(founders.out, /Dylan Patel\s+SemiAnalysis\s+One intro\s+Found\s+Ask Jacob Effron for an intro/);
});

test('find shows 25 unless --all', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ t: 'p', n: `Coach ${i}`, title: 'Coach' }));
  const text = JSON.stringify({ nodes: [{ t: 'p', n: 'You', me: 1 }, ...many], edges: [] });
  const some = await run(['find', 'coach'], fakeServer({ text }));
  assert.match(some.out, /Showing 25 of 30\. Add --all for every match\./);
  const all = await run(['find', 'coach', '--all', '--json'], fakeServer({ text }));
  assert.equal(JSON.parse(all.out).people.length, 30);
});

test('a note reads the file again right before saving, so a change made elsewhere survives', async () => {
  // Between this command starting and its read, the web page added someone.
  const server = fakeServer({
    onRead: (state) => {
      const list = JSON.parse(state.text);
      if (!list.nodes.some((n) => n.n === 'Added Elsewhere')) {
        list.nodes.push({ t: 'p', n: 'Added Elsewhere', d: 1 });
        state.text = JSON.stringify(list);
      }
    },
  });
  const { code, out } = await run(['note', 'Dylan Patel', 'Met', 'at', 'the', 'summit'], server);
  assert.equal(code, 0);
  assert.deepEqual(server.state.calls, ['GET /memory/file', 'PUT /memory/write']);
  const saved = JSON.parse(server.state.writes[0]);
  assert.ok(saved.nodes.some((n) => n.n === 'Added Elsewhere'));
  const dylan = saved.nodes.find((n) => n.n === 'Dylan Patel');
  assert.equal(dylan.act[0][1], 'Note');
  assert.equal(dylan.act[0][2], 'Met at the summit');
  assert.equal(saved.pending, undefined);
  assert.match(out, /Noted on Dylan Patel: Met at the summit/);
});

test('a list fed from the owner\'s Mac gets the change appended to pending', async () => {
  const server = fakeServer({ text: JSON.stringify(sample({ mine: 'mac', pending: [{ do: 'note', who: 'Earlier' }] })) });
  const { code, out } = await run(['stage', 'Dylan Patel', 'replied', '--json'], server);
  assert.equal(code, 0);
  const saved = JSON.parse(server.state.writes[0]);
  assert.deepEqual(saved.pending, [{ do: 'note', who: 'Earlier' }, { do: 'status', who: 'Dylan Patel', status: 'replied' }]);
  const body = JSON.parse(out);
  assert.deepEqual(body, { ok: true, did: 'stage', name: 'Dylan Patel', from: 'Found', stage: 'Replied', status: 'replied', pending: true });
});

test('stage words map to statuses and unknown words are refused before any call', async () => {
  for (const [word, status] of [['found', 'prospect'], ['reached', 'sent'], ['met', 'met'], ['paying', 'paying'], ['partner', 'partner']]) {
    const server = fakeServer();
    assert.equal((await run(['stage', 'Jacob Effron', word], server)).code, 0);
    assert.equal(JSON.parse(server.state.writes[0]).nodes[1].status, status);
  }
  const server = fakeServer();
  const bad = await run(['stage', 'Jacob Effron', 'married'], server);
  assert.equal(bad.code, 2);
  assert.deepEqual(server.state.calls, []);
});

test('a missing file means a fresh list, so add works on an empty account', async () => {
  const server = fakeServer({ text: null });
  const { code, out } = await run(['add', 'Ada Byron', '--title', 'Actress', '--city=Los Angeles', '--email', 'ada@example.com'], server);
  assert.equal(code, 0);
  const saved = JSON.parse(server.state.writes[0]);
  assert.equal(saved.nodes[0].me, 1);
  assert.equal(saved.nodes[1].n, 'Ada Byron');
  assert.equal(saved.nodes[1].title, 'Actress');
  assert.equal(saved.nodes[1].city, 'Los Angeles');
  assert.deepEqual(saved.edges, [[0, 1, 'knows']]);
  assert.match(out, /Added Ada Byron \(Actress · Los Angeles\)/);

  // And reading a missing file shows an empty today, not an error.
  const empty = await run([], fakeServer({ text: null }));
  assert.equal(empty.code, 0);
  assert.match(empty.out, /Nothing is waiting on you today\./);
});

test('any other read failure stops with nothing written', async () => {
  for (const readFail of [{ status: 500, error: 'boom' }, { status: 404, error: 'Not Found' }, { status: 401, error: 'Unauthorized' }]) {
    const server = fakeServer({ readFail });
    const { code, err } = await run(['note', 'Dylan Patel', 'hi'], server);
    assert.equal(code, 1);
    assert.deepEqual(server.state.writes, []);
    assert.match(err, readFail.status === 401 ? /Sign in/ : /could not load/);
  }
  const broken = fakeServer({ text: '{"nodes": "nope"}' });
  const { code, out } = await run(['add', 'Ada', '--json'], broken);
  assert.equal(code, 1);
  assert.deepEqual(broken.state.writes, []);
  assert.match(JSON.parse(out).error, /could not be read\. Nothing was changed\./);
});

test('a refused change is not written', async () => {
  const server = fakeServer();
  const { code, err } = await run(['add', 'jacob effron'], server);
  assert.equal(code, 1);
  assert.match(err, /Jacob Effron is already on your map\./);
  assert.deepEqual(server.state.writes, []);
});

test('not signed in stops before any call', async () => {
  const out = [];
  const code = await nexusCommand(['--json'], { log: (l) => out.push(l), err: () => {}, getToken: async () => ({ token: '' }), apiRequestJson: async () => { throw new Error('no call'); } });
  assert.equal(code, 1);
  assert.match(JSON.parse(out[0]).error, /atris login/);
});

test('a subcommand with nothing after it shows how to use it', async () => {
  const server = fakeServer();
  const { code, err } = await run(['find'], server);
  assert.equal(code, 2);
  assert.match(err, /atris nexus find/);
  assert.deepEqual(server.state.calls, []);
});

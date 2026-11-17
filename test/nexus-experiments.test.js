'use strict';

// atris nexus lists / experiment / score / guess / learned / common / alike / compare / drafts,
// with every backend call faked. Only made-up people and lists appear here; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand, USAGE } = require('../commands/nexus');
const { percent, findList } = require('../commands/nexus-experiments');

const PLANTS = 'aaaaaaaa-1111-4111-8111-111111111111';
const BAKERY = 'bbbbbbbb-2222-4222-8222-222222222222';
const BAKERY2 = 'cccccccc-3333-4333-8333-333333333333';
const RAE = '11111111-0000-4000-8000-00000000000a';
const BO = '22222222-0000-4000-8000-00000000000b';

const LISTS = [
  { id: PLANTS, name: 'Austin plant shops', count: 7, made_by: 'me', created_at: '2026-11-10' },
  { id: BAKERY, name: 'Bakeries', count: 3, made_by: 'me', created_at: '2026-11-11' },
  { id: BAKERY2, name: 'bakeries', count: 2, made_by: 'helper', created_at: '2026-11-12' },
];

const SCORE = {
  list: { id: PLANTS, name: 'Austin plant shops', count: 7 },
  experiment: { guess: 'Owners reply to one-line notes', started_at: '2026-11-14', learned: null, updated_at: 'x' },
  counts: { people: 7, reached: 7, replied: 2, met: 1, signed_up: 0, paying: 0 },
  rates: { reply_rate: 0.2857, signup_rate: 0, paying_rate: null },
  people: [],
};

/** A fake Nexus. `over` replaces an answer by "METHOD /path". */
function backend(over = {}) {
  const state = { calls: [] };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    const url = new URL(pathname, 'https://x.test');
    state.calls.push({ method, url: pathname, path: url.pathname, query: url.search, body: options.body });
    const key = `${method} ${url.pathname}`;
    if (over[key]) return typeof over[key] === 'function' ? over[key](options) : over[key];
    let m;
    if (key === 'GET /nexus/lists') return answer(200, { lists: LISTS });
    if (method === 'GET' && (m = /^\/nexus\/lists\/([^/]+)\/score$/.exec(url.pathname))) {
      return answer(200, m[1] === PLANTS ? SCORE : { ...SCORE, list: { id: m[1] }, experiment: null });
    }
    if (method === 'PATCH' && (m = /^\/nexus\/lists\/([^/]+)\/experiment$/.exec(url.pathname))) {
      return answer(200, { list: { id: m[1], name: 'Austin plant shops', count: 7 }, experiment: { guess: options.body.guess || null, learned: options.body.learned || null, started_at: '2026-11-16', updated_at: 'x' } });
    }
    if (key === 'POST /nexus/lists/compare') {
      return answer(200, {
        lists: options.body.list_ids.map((id) => ({
          list: { id, name: LISTS.find((l) => l.id === id).name, count: 7 },
          experiment: null,
          counts: { people: 7, reached: id === PLANTS ? 7 : 2, replied: id === PLANTS ? 2 : 0, met: 0, signed_up: 0, paying: 0 },
          rates: { reply_rate: id === PLANTS ? 0.2857 : null, signup_rate: 0, paying_rate: 0 },
        })),
        best: PLANTS,
      });
    }
    if (method === 'GET' && /^\/nexus\/lists\/[^/]+\/common$/.test(url.pathname)) {
      return answer(200, {
        list_id: PLANTS, count: 7,
        traits: [
          { kind: 'city', key: 'austin', label: 'Austin', count: 7, share: 1 },
          { kind: 'title_word', key: 'owner', label: 'owner', count: 5, share: 0.71 },
          { kind: 'company', key: 'green', label: 'Green Co', count: 2, share: 0.29 },
        ],
        ties: { inside: 3, members_tied: 4, outside: [{ person_id: BO, name: 'Bo Example', knows: 3 }] },
      });
    }
    if (method === 'POST' && /^\/nexus\/lists\/[^/]+\/alike$/.test(url.pathname)) {
      return answer(200, { list_id: PLANTS, count: 7, people: [
        { person_id: RAE, name: 'Rae Sample', score: 1.2, why: ['same city', 'title: owner'] },
        { person_id: BO, name: 'Bo Example', score: 0.6, why: ['same city'] },
      ] });
    }
    if (method === 'POST' && (m = /^\/nexus\/lists\/([^/]+)\/people$/.exec(url.pathname))) {
      return answer(200, { list: { id: m[1], name: 'Austin plant shops', count: 7 + options.body.add.length }, skipped: 0 });
    }
    if (method === 'GET' && /^\/nexus\/lists\/[^/]+\/drafts$/.test(url.pathname)) {
      return answer(200, { count: 1, without_draft: 6, drafts: [
        { person_id: RAE, step: 1, by: 'you', at: 'x', subject: 'Your weekend orders', body: 'Saw the post about weekend orders.\nSecond line here.' },
      ] });
    }
    if (key === 'POST /nexus/people/search') return answer(200, { people: [{ id: RAE, name: 'Rae Sample' }], total: 1 });
    if (key === 'POST /nexus/experiments') {
      return answer(200, {
        list: { id: PLANTS, name: options.body.name, count: 7 }, added: 5, already_there: 2,
        experiment: { guess: options.body.guess || null, started_at: '2026-11-16', learned: null },
        counts: { people: 7, reached: 0, replied: 0, met: 0, signed_up: 0, paying: 0 },
        rates: { reply_rate: null, signup_rate: 0, paying_rate: 0 },
        common: { traits: [{ kind: 'city', key: 'austin', label: 'Austin', count: 7, share: 1 }] },
        alike: { people: [{ person_id: RAE, name: 'Rae Sample', score: 1.2, why: ['same city'] }] },
        without_email: 2, without_draft: 7,
        next: ['Write a note to the 5 with an email.'],
      });
    }
    return answer(404, { detail: 'Not Found' });
  };
  return { request, state };
}

function runner(server, deps = {}) {
  return async (args) => {
    const out = [];
    const errs = [];
    const code = await nexusCommand(args, {
      log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => new Date('2026-11-16T09:00:00Z'),
      getToken: async () => ({ token: 't' }), apiRequestJson: server.request,
      client: () => ({ read: async () => { throw new Error('the saved list is never read'); }, write: async () => { throw new Error('never written'); } }),
      ...deps,
    });
    return { code, out: out.join('\n'), err: errs.join('\n') };
  };
}

// Every test: nothing sends, and no name, guess or note text sits in a web address.
function cleanUrls(server, secrets = []) {
  for (const call of server.state.calls) {
    assert.doesNotMatch(call.path, /\/(send|reply)$/, `no send route is ever called: ${call.path}`);
    assert.equal(call.query, '', `no query string: ${call.url}`);
    for (const s of secrets) assert.ok(!decodeURIComponent(call.url).toLowerCase().includes(String(s).toLowerCase()), `"${s}" never goes in a web address`);
  }
}

const notFetched = (server, re) => assert.ok(!server.state.calls.some((c) => re.test(c.path)), `no call to ${re}`);

test('percent: whole percents, a dash when there is no rate', () => {
  assert.equal(percent(0.2857), '29%');
  assert.equal(percent(0), '0%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(null), '-');
  assert.equal(percent(undefined), '-');
});

test('findList: exact name any case, id, none, several', () => {
  assert.equal(findList(LISTS, 'austin PLANT shops').list.id, PLANTS);
  assert.equal(findList(LISTS, PLANTS.toUpperCase()).list.id, PLANTS);
  assert.equal(findList(LISTS, 'Austin plants').list, undefined);
  assert.deepEqual(findList(LISTS, 'Austin plants').close.map((l) => l.id), [PLANTS]);
  const two = findList(LISTS, 'Bakeries');
  assert.equal(two.list, undefined);
  assert.equal(two.matches.length, 2);
});

test('the new words are in the help and never fall through to a person search', async () => {
  for (const word of ['lists', 'experiment', 'score', 'guess', 'learned', 'common', 'alike', 'compare', 'drafts']) {
    assert.match(USAGE, new RegExp(`atris nexus ${word}\\b`), `help names ${word}`);
  }
  const server = backend();
  const go = runner(server);
  for (const args of [['lists'], ['score', 'Austin plant shops'], ['common', 'Austin plant shops'], ['alike', 'Austin plant shops'], ['drafts', 'Austin plant shops'], ['compare', 'Austin plant shops', BAKERY], ['guess', 'Austin plant shops', 'x'], ['learned', 'Austin plant shops', 'y'], ['experiment', 'X', '--city', 'Austin']]) {
    await go(args);
  }
  assert.ok(!server.state.calls.some((c) => c.path === '/nexus/people/search' && c.body && c.body.q), 'no person search by words');
  assert.ok(!server.state.calls.some((c) => c.path === '/nexus/people' || c.path.startsWith('/memory')), 'the people list is never read');
});

test('a list name that matches nothing names the close ones and exits 1', async () => {
  const server = backend();
  const r = await runner(server)(['score', 'Austin plants']);
  assert.equal(r.code, 1);
  assert.match(r.err, /None of your saved lists is called "Austin plants"/);
  assert.match(r.err, /Austin plant shops/);
  notFetched(server, /\/score$/);
});

test('a list name that matches several lists them with ids and exits 1', async () => {
  const server = backend();
  const r = await runner(server)(['score', 'BAKERIES']);
  assert.equal(r.code, 1);
  assert.match(r.err, /2 of your lists are called that/);
  assert.match(r.err, new RegExp(BAKERY));
  assert.match(r.err, new RegExp(BAKERY2));
  notFetched(server, /\/score$/);
  const j = await runner(server)(['score', 'bakeries', '--json']);
  assert.equal(j.code, 1);
  const data = JSON.parse(j.out);
  assert.equal(data.ok, false);
  assert.equal(data.matches.length, 2);
});

test('a list given by id works', async () => {
  const server = backend();
  const r = await runner(server)(['score', PLANTS]);
  assert.equal(r.code, 0);
  assert.equal(server.state.calls.at(-1).path, `/nexus/lists/${PLANTS}/score`);
});

test('lists: each list with its count, the guess on a second line', async () => {
  const server = backend();
  const r = await runner(server)(['lists']);
  assert.equal(r.code, 0);
  assert.match(r.out, /3 saved lists/);
  assert.match(r.out, /Austin plant shops, 7 people\n {4}Guess: Owners reply to one-line notes/);
  assert.match(r.out, /Bakeries, 3 people/);
  assert.equal(server.state.calls.filter((c) => c.path.endsWith('/score')).length, 3);
  cleanUrls(server, ['Austin', 'Bakeries']);
  const j = await runner(server)(['lists', '--json']);
  const data = JSON.parse(j.out);
  assert.equal(data.lists[0].experiment.guess, 'Owners reply to one-line notes');
});

test('score: five numbers, rates as whole percents, a dash for none, the guess and start day', async () => {
  const server = backend();
  const r = await runner(server)(['score', 'Austin plant shops']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Austin plant shops: 7 people/);
  assert.match(r.out, /Guess: Owners reply to one-line notes/);
  assert.match(r.out, /Started: 2026-11-14/);
  for (const line of ['7 reached', '2 replied', '1 met', '0 became users', '0 paying']) assert.match(r.out, new RegExp(`^  ${line}$`, 'm'));
  assert.match(r.out, /29% replied, 0% became users, - paying/);
  const call = server.state.calls.at(-1);
  assert.equal(call.method, 'GET');
  assert.equal(call.path, `/nexus/lists/${PLANTS}/score`);
  cleanUrls(server, ['Austin plant shops']);
});

test('score --json prints the raw answer', async () => {
  const server = backend();
  const r = await runner(server)(['score', 'Austin plant shops', '--json']);
  const data = JSON.parse(r.out);
  assert.equal(data.ok, true);
  assert.deepEqual(data.counts, SCORE.counts);
  assert.deepEqual(data.rates, SCORE.rates);
});

test('guess and learned PATCH the experiment with the words in the body only', async () => {
  const server = backend();
  const go = runner(server);
  const g = await go(['guess', 'Austin plant shops', 'Owners', 'answer', 'by', 'Friday']);
  assert.equal(g.code, 0);
  let call = server.state.calls.at(-1);
  assert.equal(call.method, 'PATCH');
  assert.equal(call.path, `/nexus/lists/${PLANTS}/experiment`);
  assert.deepEqual(call.body, { guess: 'Owners answer by Friday' });
  assert.match(g.out, /Guess kept on Austin plant shops: Owners answer by Friday/);
  const l = await go(['learned', PLANTS, 'Mornings work best']);
  assert.equal(l.code, 0);
  call = server.state.calls.at(-1);
  assert.deepEqual(call.body, { learned: 'Mornings work best' });
  cleanUrls(server, ['Owners answer', 'Mornings', 'Austin plant']);
});

test('guess with no words refuses before any call', async () => {
  const server = backend();
  const r = await runner(server)(['guess', 'Austin plant shops']);
  assert.equal(r.code, 2);
  assert.equal(server.state.calls.length, 0);
});

test('a refusal from the service exits non-zero with its message', async () => {
  const server = backend({ 'PATCH /nexus/lists/aaaaaaaa-1111-4111-8111-111111111111/experiment': { ok: false, status: 422, data: { detail: 'A guess is at most 500 characters.' } } });
  const r = await runner(server)(['guess', 'Austin plant shops', 'too long']);
  assert.equal(r.code, 1);
  assert.match(r.err, /A guess is at most 500 characters\./);
  const j = await runner(server)(['guess', 'Austin plant shops', 'too long', '--json']);
  assert.equal(j.code, 1);
  assert.equal(JSON.parse(j.out).error, 'A guess is at most 500 characters.');
});

test('common: traits grouped by kind, with ties', async () => {
  const server = backend();
  const r = await runner(server)(['common', 'Austin plant shops']);
  assert.equal(r.code, 0);
  assert.match(r.out, /What the 7 people on Austin plant shops share/);
  assert.match(r.out, /Company\n {2}Green Co, 2 of 7\nCity\n {2}Austin, 7 of 7\nTitle word\n {2}owner, 5 of 7/);
  assert.match(r.out, /3 links inside the list, 4 people know someone else on it/);
  assert.match(r.out, /Bo Example \(3\)/);
  assert.equal(server.state.calls.at(-1).method, 'GET');
  assert.equal(server.state.calls.at(-1).path, `/nexus/lists/${PLANTS}/common`);
});

test('alike shows lookalikes and adds nothing without --add', async () => {
  const server = backend();
  const r = await runner(server, { confirm: async () => { throw new Error('never asked'); } })(['alike', 'Austin plant shops', '--limit', '10']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Rae Sample, score 1.2: same city, title: owner/);
  const call = server.state.calls.find((c) => c.path.endsWith('/alike'));
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { limit: 10, include_catalog: false });
  notFetched(server, /\/people$/);
});

test('alike --add asks first and adds nothing on no', async () => {
  const server = backend();
  let asked = '';
  const r = await runner(server, { confirm: async (q) => { asked = q; return false; } })(['alike', 'Austin plant shops', '--add']);
  assert.equal(r.code, 0);
  assert.equal(asked, 'Add these 2 people to Austin plant shops? [y/N] ');
  assert.match(r.out, /Nothing was added/);
  notFetched(server, /\/lists\/[^/]+\/people$/);
});

test('alike --add with yes adds through the list people route', async () => {
  const server = backend();
  const r = await runner(server, { confirm: async () => true })(['alike', 'Austin plant shops', '--add']);
  assert.equal(r.code, 0);
  const call = server.state.calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, `/nexus/lists/${PLANTS}/people`);
  assert.deepEqual(call.body, { add: [RAE, BO] });
  assert.match(r.out, /Added 2 people to Austin plant shops, 9 on it now/);
  cleanUrls(server, ['Rae', 'Austin plant']);
});

test('alike --add --yes skips the question; --json --add without --yes adds nothing', async () => {
  const server = backend();
  const y = await runner(server, { confirm: async () => { throw new Error('never asked'); } })(['alike', 'Austin plant shops', '--add', '--yes']);
  assert.equal(y.code, 0);
  assert.equal(server.state.calls.filter((c) => /\/lists\/[^/]+\/people$/.test(c.path)).length, 1);
  const server2 = backend();
  const j = await runner(server2, { confirm: async () => { throw new Error('never asked'); } })(['alike', 'Austin plant shops', '--add', '--json']);
  assert.equal(j.code, 1);
  assert.equal(JSON.parse(j.out).added, 0);
  notFetched(server2, /\/lists\/[^/]+\/people$/);
});

test('compare: one row per list, the best named last, ids in the body', async () => {
  const server = backend();
  const r = await runner(server)(['compare', 'Austin plant shops', BAKERY]);
  assert.equal(r.code, 0);
  const call = server.state.calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/nexus/lists/compare');
  assert.deepEqual(call.body, { list_ids: [PLANTS, BAKERY] });
  assert.match(r.out, /list\s+people\s+reached\s+replied\s+reply rate\s+became users\s+paying/);
  assert.match(r.out, /Austin plant shops\s+7\s+7\s+2\s+29%/);
  assert.match(r.out, /Bakeries\s+7\s+2\s+0\s+-/);
  assert.match(r.out.split('\n').at(-1), /Best so far: Austin plant shops/);
});

test('compare needs two to six lists and refuses the same list twice', async () => {
  const server = backend();
  assert.equal((await runner(server)(['compare', 'Austin plant shops'])).code, 2);
  assert.equal(server.state.calls.length, 0);
  const twice = await runner(server)(['compare', 'Austin plant shops', PLANTS]);
  assert.equal(twice.code, 2);
  notFetched(server, /compare$/);
});

test('drafts: who has a note and who does not, first lines, --full for whole notes', async () => {
  const server = backend();
  const r = await runner(server)(['drafts', 'Austin plant shops']);
  assert.equal(r.code, 0);
  assert.match(r.out, /1 person has a note waiting, 6 do not/);
  assert.match(r.out, /Rae Sample, note 1: Your weekend orders\n {2}Saw the post about weekend orders\./);
  assert.doesNotMatch(r.out, /Second line here/);
  const full = await runner(server)(['drafts', 'Austin plant shops', '--full']);
  assert.match(full.out, /Second line here/);
  assert.ok(server.state.calls.some((c) => c.method === 'GET' && c.path === `/nexus/lists/${PLANTS}/drafts`));
  cleanUrls(server, ['Austin plant', 'weekend']);
});

test('experiment: POSTs the words in the body and prints the list, share, lookalikes and next', async () => {
  const server = backend();
  const r = await runner(server)(['experiment', 'Austin plant shops', '--city', 'Austin', '--work', 'plant shop', '--group', 'Founders', '--guess', 'Owners reply fast']);
  assert.equal(r.code, 0, r.err);
  const call = server.state.calls.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/nexus/experiments');
  assert.equal(call.body.name, 'Austin plant shops');
  assert.equal(call.body.city, 'Austin');
  assert.equal(call.body.work, 'plant shop');
  assert.equal(call.body.group, 'Founders');
  assert.equal(call.body.guess, 'Owners reply fast');
  assert.match(call.body.ref, /^exp-[0-9a-f]{32}$/);
  assert.match(r.out, /"Austin plant shops": 7 people on the list, 5 just added, 2 already there\./);
  assert.match(r.out, /Guess: Owners reply fast/);
  assert.match(r.out, /- replied, 0% became users, 0% paying/);
  assert.match(r.out, /City: Austin, 7 of 7/);
  assert.match(r.out, /Rae Sample, score 1.2: same city/);
  assert.match(r.out, /2 people have no email yet\. 7 people have no note yet\./);
  assert.match(r.out, /Next\n {2}Write a note to the 5 with an email\./);
  notFetched(server, /^\/nexus\/lists$/);
  cleanUrls(server, ['Austin', 'plant', 'Founders', 'Owners']);
});

test('experiment says plainly when the service part is not live yet', async () => {
  for (const status of [404, 405]) {
    const server = backend({ 'POST /nexus/experiments': { ok: false, status, data: { detail: status === 404 ? 'Not Found' : 'Method Not Allowed' } } });
    const r = await runner(server)(['experiment', 'Austin plant shops', '--city', 'Austin']);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'Making an experiment in one step is not live on the service yet. Nothing was made.');
    const j = await runner(server)(['experiment', 'Austin plant shops', '--city', 'Austin', '--json']);
    assert.equal(JSON.parse(j.out).not_live, true);
  }
});

test('experiment needs a name and --city before any call', async () => {
  const server = backend();
  assert.equal((await runner(server)(['experiment', '--city', 'Austin'])).code, 2);
  assert.equal((await runner(server)(['experiment', 'Austin plant shops'])).code, 2);
  assert.equal(server.state.calls.length, 0);
});

test('an unknown flag is refused before any call', async () => {
  const server = backend();
  const r = await runner(server)(['alike', 'Austin plant shops', '--ad']);
  assert.equal(r.code, 2);
  assert.equal(server.state.calls.length, 0);
});

test('a locked plan exits non-zero with the plan line', async () => {
  const server = backend({ 'GET /nexus/lists': { ok: false, status: 402, data: { detail: 'locked' } } });
  const r = await runner(server)(['score', 'Austin plant shops', '--json']);
  assert.equal(r.code, 1);
  const data = JSON.parse(r.out);
  assert.equal(data.status, 402);
  assert.match(data.error, /paid plan/);
});

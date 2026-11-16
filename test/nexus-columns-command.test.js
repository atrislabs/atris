'use strict';

// atris nexus set / unset / undo / columns / table, with every backend call faked.
// Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nexusCommand } = require('../commands/nexus');

const NOW = new Date(2026, 10, 15, 21);
const RAE = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const PERSON = {};
const HELPER = { CLAUDECODE: '1', ATRIS_MEMBER: 'lucius' };

function card(id, name, over = {}, extra = {}) {
  return { id, mine: true, name, company_name: null, location_raw: null, private: { stage: 'found', closeness: 1, extra }, ...over };
}

function backend(people) {
  const state = { calls: [], people };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body });
    if (method === 'POST' && url.pathname === '/nexus/people/search') {
      const q = String(options.body.q || '').toLowerCase();
      const hits = state.people.filter((p) => p.name.toLowerCase().includes(q));
      return answer(200, { people: hits, total: hits.length });
    }
    if (method === 'GET' && url.pathname === '/nexus/people') {
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      return answer(200, { people: state.people.slice(offset, offset + limit), total: state.people.length });
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
  return { state, request };
}

async function run(args, server, env = PERSON) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => NOW, env,
    getToken: async () => ({ token: 't' }), apiRequestJson: server.request,
    client: () => ({ read: async () => { throw new Error('the saved list is never read'); }, write: async () => { throw new Error('never written'); } }),
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

const writes = (server) => server.state.calls.filter((c) => c.method === 'PATCH');

test('set puts your value on the card, marked as yours', async () => {
  const server = backend([card(RAE, 'Rae Sample')]);
  const { code, out } = await run(['set', 'Rae Sample', 'met at', 'AI Engineer Fair'], server);
  assert.equal(code, 0);
  assert.match(out, /Rae Sample: met_at is AI Engineer Fair/);
  const [w] = writes(server);
  assert.equal(w.path, `/nexus/people/${RAE}/mine`);
  assert.deepEqual(w.body.extra.col_met_at, { v: 'AI Engineer Fair', by: 'you', at: NOW.toISOString() });
});

test('a number reads as a number, so it can be graphed', async () => {
  const server = backend([card(RAE, 'Rae Sample')]);
  await run(['set', 'Rae Sample', 'check_size', '250000', '--json'], server);
  assert.equal(writes(server)[0].body.extra.col_check_size.v, 250000);
});

test('a helper must say where it found the value', async () => {
  const server = backend([card(RAE, 'Rae Sample')]);
  const { code, err } = await run(['set', 'Rae Sample', 'linkedin_live', 'yes'], server, HELPER);
  assert.equal(code, 2);
  assert.match(err, /must say where it found this/);
  assert.equal(server.state.calls.length, 0, 'nothing is sent');
});

test('--as-helper counts as a helper even in a person\'s shell', async () => {
  const server = backend([card(RAE, 'Rae Sample')]);
  const { code } = await run(['set', 'Rae Sample', 'met_at', 'Fair', '--as-helper'], server);
  assert.equal(code, 2);
});

test('a helper with a source writes, named, with the page, and the old value kept', async () => {
  const server = backend([card(RAE, 'Rae Sample', {}, { col_role: { v: 'Engineer', by: 'scout', at: '2026-11-01T00:00:00.000Z' } })]);
  const { code } = await run(['set', 'Rae Sample', 'role', 'CTO', '--source', 'https://example.com/team'], server, HELPER);
  assert.equal(code, 0);
  const v = writes(server)[0].body.extra.col_role;
  assert.equal(v.by, 'lucius');
  assert.equal(v.src, 'https://example.com/team');
  assert.deepEqual(v.was, { v: 'Engineer', by: 'scout', at: '2026-11-01T00:00:00.000Z' });
});

test('a helper never changes or removes a value you set yourself', async () => {
  const mine = { col_warmth: { v: 'close friend', by: 'you', at: '2026-11-01T00:00:00.000Z' } };
  const server = backend([card(RAE, 'Rae Sample', {}, mine)]);
  const set = await run(['set', 'Rae Sample', 'warmth', 'cold', '--source', 'a guess'], server, HELPER);
  assert.equal(set.code, 1);
  assert.match(set.err, /yourself, so a helper does not change it/);
  const unset = await run(['unset', 'Rae Sample', 'warmth'], server, HELPER);
  assert.equal(unset.code, 1);
  assert.equal(writes(server).length, 0);
});

test('undo puts back the value before the last change', async () => {
  const server = backend([card(RAE, 'Rae Sample', {}, { col_role: { v: 'CTO', by: 'lucius', at: 'b', src: 's', was: { v: 'Engineer', by: 'you', at: 'a' } } })]);
  const { code, out } = await run(['undo', 'Rae Sample', 'role'], server);
  assert.equal(code, 0);
  assert.match(out, /back to Engineer/);
  assert.deepEqual(writes(server)[0].body.extra.col_role, { v: 'Engineer', by: 'you', at: 'a' });
});

test('unset takes the column off', async () => {
  const server = backend([card(RAE, 'Rae Sample', {}, { col_role: { v: 'CTO', by: 'you', at: 'a' } })]);
  const { code } = await run(['unset', 'Rae Sample', 'role'], server);
  assert.equal(code, 0);
  assert.deepEqual(writes(server)[0].body, { extra: { col_role: null } });
});

test('a column cannot shadow one every card already has', async () => {
  const server = backend([card(RAE, 'Rae Sample')]);
  const { code, err } = await run(['set', 'Rae Sample', 'stage', 'met'], server);
  assert.equal(code, 2);
  assert.match(err, /already on every card/);
});

test('columns counts each column, its top values and who wrote them', async () => {
  const server = backend([
    card(RAE, 'Rae Sample', {}, { col_atris_account: { v: 'yes', by: 'lucius', at: '2026-11-15' }, cid: 3 }),
    card(BO, 'Bo Example', {}, { col_atris_account: { v: 'yes', by: 'you', at: '2026-11-14' } }),
  ]);
  const { code, out } = await run(['columns', '--json'], server);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.people, 2);
  assert.deepEqual(data.columns, [{ name: 'atris_account', people: 2, by_you: 1, by_helpers: 1, last_set: '2026-11-15', top_values: [{ value: 'yes', count: 2 }] }]);
});

test('table gives everyone with the picked columns, filtered, as csv', async () => {
  const server = backend([
    card(RAE, 'Rae Sample', { company_name: 'Sample, Inc' }, { col_met_at: { v: 'Fair', by: 'you', at: 'a' } }),
    card(BO, 'Bo Example', { company_name: 'Example' }),
  ]);
  const all = await run(['table', '--with', 'company,met_at', '--csv'], server);
  assert.equal(all.out, 'name,company,met_at\nRae Sample,"Sample, Inc",Fair\nBo Example,Example,');
  const some = await run(['table', '--with', 'met_at', '--where', 'met_at=fair', '--json'], server);
  assert.deepEqual(JSON.parse(some.out).rows.map((r) => r.name), ['Rae Sample']);
  const none = await run(['table', '--where', '!met_at', '--json'], server);
  assert.deepEqual(JSON.parse(none.out).rows.map((r) => r.name), ['Bo Example']);
});

test('table reads every page of a long list', async () => {
  const many = Array.from({ length: 450 }, (_, i) => card(`id-${i}`, `Person ${i}`));
  const server = backend(many);
  const { out } = await run(['table', '--json'], server);
  assert.equal(JSON.parse(out).total, 450);
  assert.deepEqual(server.state.calls.map((c) => c.query.offset), ['0', '200', '400']);
});

test('two people with the name: list them, change nothing', async () => {
  const server = backend([card(RAE, 'Rae Sample'), card(BO, 'Rae Sampleton')]);
  const { code } = await run(['set', 'Rae', 'met_at', 'Fair'], server);
  assert.equal(code, 1);
  assert.equal(writes(server).length, 0);
});

'use strict';

// atris nexus pull, local and push-notes, with every backend call faked and the local copy
// in a temporary folder. Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { nexusCommand } = require('../commands/nexus');

const NOW = new Date(2026, 10, 16, 12);
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const RAE = id(1);
const BO = id(2);
const OTHER = id(3);
const LIST = 'aaaaaaaa-0000-4000-8000-000000000000';

function mineCard(cid, name, over = {}, priv = {}) {
  return {
    id: cid, is_public: false, mine: true, name, title: null, company_name: null, location_raw: null, place: null,
    private: { stage: 'found', closeness: 1, note: null, next_move: null, due_on: null, paid_cents: 0, paid_checked: false, last_touch_at: null, via_person_id: null, group_name: null, extra: {} },
    ...over,
    ...(Object.keys(priv).length ? { private: { stage: 'found', closeness: 1, note: null, ...priv } } : {}),
  };
}

function seed(extra = 0) {
  const people = [
    mineCard(RAE, 'Rae Sample', { title: 'Founder', company_name: 'Sample Co', location_raw: 'Austin, TX', business_notes: 'team secret' }, { stage: 'replied', note: 'Likes email', next_move: 'Call back Friday', group_name: 'Founders' }),
    mineCard(BO, 'Bo Example', { company_name: 'Example Inc' }),
    { id: OTHER, is_public: true, mine: false, name: 'Pat Public', private: null },
  ];
  for (let i = 0; i < extra; i++) people.push(mineCard(id(100 + i), `Person ${String(i).padStart(3, '0')}`));
  return {
    people,
    touches: { [RAE]: [{ id: 't1', person_id: RAE, kind: 'note', body: 'met at the climbing gym', at: '2026-11-10T09:00:00+00:00' }] },
    lists: [{ id: LIST, name: 'Warm', count: 1, made_by: 'me' }],
    listPeople: { [LIST]: [RAE] },
  };
}

function backend({ data = seed(), down = false, gone = [] } = {}) {
  const state = { calls: [], data, touchesSent: [] };
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, data: body, error: body && body.detail });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body });
    if (down) return { ok: false, status: 0, data: null, error: 'ECONNREFUSED' };
    const d = state.data;
    const key = `${method} ${url.pathname}`;
    let m;
    if (key === 'GET /nexus/people') {
      // Cursor paging: the cursor is the index of the next card.
      const limit = Number(url.searchParams.get('limit'));
      const start = Number(url.searchParams.get('cursor') || 0);
      const page = d.people.slice(start, start + limit);
      const full = page.length === limit;
      return answer(200, { total: url.searchParams.get('cursor') ? null : d.people.length, limit, offset: 0, people: page, next_cursor: full ? String(start + limit) : null });
    }
    if (key === 'GET /nexus/touches') return answer(200, { per_person: 20, touches: d.touches });
    if (key === 'GET /nexus/lists') return answer(200, { lists: d.lists });
    if (key === 'POST /nexus/people/search') {
      const ids = d.listPeople[options.body.list_id] || [];
      return answer(200, { total: ids.length, people: d.people.filter((c) => ids.includes(c.id)), from_businesses: [{ id: OTHER, name: 'Pat Public', business_id: 'b1' }] });
    }
    if ((m = /^GET \/nexus\/people\/([^/]+)$/.exec(key))) {
      const card = gone.includes(m[1]) ? null : d.people.find((c) => c.id === m[1]);
      return card ? answer(200, { card, ties: [], touches: [] }) : answer(404, { detail: 'Not found' });
    }
    if (key === 'POST /nexus/touches') {
      state.touchesSent.push(options.body);
      return answer(200, { touch: { id: `new${state.touchesSent.length}`, ...options.body } });
    }
    if ((m = /^PATCH \/nexus\/people\/([^/]+)\/mine$/.exec(key))) {
      const card = d.people.find((c) => c.id === m[1]);
      card.private = { ...card.private, ...options.body };
      return answer(200, { card });
    }
    throw new Error(`unexpected call ${key}`);
  };
  return { state, request };
}

const offline = async () => { throw new Error('no network on this test'); };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nexus');
}

async function run(args, dir, server, deps = {}) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server ? server.request : offline,
    now: () => NOW,
    nexusDir: dir,
    ...deps,
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('pull pages through every card and keeps only the caller\'s own layer', async (t) => {
  const dir = tempDir(t);
  const server = backend({ data: seed(250) });
  const r = await run(['pull'], dir, server);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Pulled 252 people into .*: 252 new, 0 changed, 0 removed, 0 the same\./);
  assert.match(r.out, /1 saved list copied\./);
  const pages = server.state.calls.filter((c) => c.path === '/nexus/people');
  assert.equal(pages.length, 2);
  assert.equal(pages[1].query.cursor, '200');

  const files = fs.readdirSync(path.join(dir, 'people'));
  assert.equal(files.length, 252);
  assert.ok(!files.includes(`${OTHER}.json`), 'a card that is not the caller\'s is never written');
  const rae = readJson(path.join(dir, 'people', `${RAE}.json`));
  assert.equal(rae.card.name, 'Rae Sample');
  assert.equal(rae.card.private.note, 'Likes email');
  assert.equal(rae.card.business_notes, undefined, 'fields outside the card are left out');
  assert.equal(rae.touches[0].body, 'met at the climbing gym');
  assert.equal(fs.statSync(path.join(dir, 'people', `${RAE}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  const index = readJson(path.join(dir, 'index.json'));
  assert.equal(index.total, 252);
  assert.equal(index.people[0].name, 'Bo Example');
  const lists = readJson(path.join(dir, 'lists.json'));
  assert.deepEqual(lists.lists, [{ id: LIST, name: 'Warm', count: 1, people: [RAE] }]);
  const all = fs.readdirSync(dir).join(' ') + JSON.stringify(index) + JSON.stringify(lists);
  assert.doesNotMatch(all, /Pat Public|team secret|business_id/);
});

test('pulling again updates changed people and removes ones gone from the cloud', async (t) => {
  const dir = tempDir(t);
  const server = backend();
  assert.equal((await run(['pull'], dir, server)).code, 0);
  server.state.data.people = server.state.data.people.filter((c) => c.id !== BO);
  server.state.data.people[0].private.stage = 'met';
  const r = await run(['pull', '--json'], dir, server);
  assert.equal(r.code, 0, r.err);
  const done = JSON.parse(r.out);
  assert.deepEqual([done.people, done.added, done.changed, done.removed, done.same], [1, 0, 1, 1, 0]);
  assert.ok(!fs.existsSync(path.join(dir, 'people', `${BO}.json`)));
  assert.equal(readJson(path.join(dir, 'people', `${RAE}.json`)).card.private.stage, 'met');
});

test('a pull that cannot reach the store leaves the local copy as it was', async (t) => {
  const dir = tempDir(t);
  assert.equal((await run(['pull'], dir, backend())).code, 0);
  const before = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  const r = await run(['pull'], dir, backend({ down: true }));
  assert.equal(r.code, 1);
  assert.match(r.err, /did not answer\. Your local copy was not changed\./);
  assert.equal(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(dir, 'people')).length, 2);
});

test('local search and show read only the folder, with no network and no sign in', async (t) => {
  const dir = tempDir(t);
  assert.equal((await run(['pull'], dir, backend())).code, 0);
  const noLogin = { getToken: async () => { throw new Error('should not sign in'); } };

  const s = await run(['local', 'search', 'climbing'], dir, null, noLogin);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /1 person matches "climbing" in your local copy\./);
  assert.match(s.out, /Rae Sample\s+Sample Co/);

  const none = await run(['local', 'search', 'nobody'], dir, null, noLogin);
  assert.match(none.out, /No one in your local copy matches "nobody"\./);

  const show = await run(['local', 'show', 'rae'], dir, null, noLogin);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /^Rae Sample/);
  assert.match(show.out, /Next: Call back Friday/);
  assert.match(show.out, /met at the climbing gym/);
  assert.match(show.out, new RegExp(`Id: ${RAE}`));

  const byId = await run(['local', 'show', BO.slice(0, 8), '--json'], dir, null, noLogin);
  assert.equal(JSON.parse(byId.out).card.name, 'Bo Example');
});

test('local commands say how to start when there is no copy yet', async (t) => {
  const dir = tempDir(t);
  const r = await run(['local', 'search', 'rae'], dir, null);
  assert.equal(r.code, 1);
  assert.match(r.err, /No local copy yet\. Run: atris nexus pull/);
});

test('a note written offline waits in the inbox, then push-notes sends it and clears it', async (t) => {
  const dir = tempDir(t);
  const server = backend();
  assert.equal((await run(['pull'], dir, server)).code, 0);

  const n = await run(['local', 'note', RAE, 'Wants', 'a', 'demo', 'in', 'December'], dir, null);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /Noted on Rae Sample, on this computer only\./);
  assert.equal(readJson(path.join(dir, 'inbox.json')).notes.length, 1);
  assert.match((await run(['local', 'show', RAE], dir, null)).out, /Not sent yet\n {2}Wants a demo in December/);

  const off = await run(['push-notes'], dir, backend({ down: true }));
  assert.equal(off.code, 1);
  assert.match(off.err, /did not answer\. Your notes are still waiting/);
  assert.equal(readJson(path.join(dir, 'inbox.json')).notes.length, 1);

  const p = await run(['push-notes'], dir, server);
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /Sent 1 note\./);
  assert.equal(server.state.touchesSent.length, 1);
  assert.deepEqual({ ...server.state.touchesSent[0], at: undefined }, { person_id: RAE, kind: 'note', body: 'Wants a demo in December', at: undefined });
  assert.equal(server.state.data.people[0].private.note, 'Likes email | Wants a demo in December');
  assert.deepEqual(readJson(path.join(dir, 'inbox.json')).notes, []);
  const local = readJson(path.join(dir, 'people', `${RAE}.json`));
  assert.equal(local.touches[0].body, 'Wants a demo in December');
  assert.doesNotMatch((await run(['local', 'show', RAE], dir, null)).out, /Not sent yet/);

  const again = await run(['push-notes'], dir, server);
  assert.match(again.out, /No notes are waiting to be sent\./);
  assert.equal(server.state.touchesSent.length, 1, 'nothing is sent twice');
});

test('a note for someone gone from the store is kept, the rest are sent', async (t) => {
  const dir = tempDir(t);
  const server = backend();
  assert.equal((await run(['pull'], dir, server)).code, 0);
  await run(['local', 'note', 'Bo Example', 'first'], dir, null);
  await run(['local', 'note', 'Rae Sample', 'second'], dir, null);
  const r = await run(['push-notes'], dir, backend({ data: server.state.data, gone: [BO] }));
  assert.equal(r.code, 0);
  assert.match(r.err, /Bo Example is not on your list in the store/);
  assert.match(r.out, /Sent 1 note\. 1 note is still waiting\./);
  assert.deepEqual(readJson(path.join(dir, 'inbox.json')).notes.map((n) => n.text), ['first']);
});

test('local note needs a name and text, and an unknown local word shows how', async (t) => {
  const dir = tempDir(t);
  assert.equal((await run(['local', 'note', RAE], dir, null)).code, 2);
  const r = await run(['local', 'nope'], dir, null);
  assert.equal(r.code, 2);
  assert.match(r.err, /atris nexus local takes search/);
});

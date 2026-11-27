'use strict';

// atris nexus hour --new-only, with every backend call, the screen and the clock faked.
// Only made-up people appear here. Nothing is sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { nexusCommand } = require('../commands/nexus');

const START = new Date(2026, 10, 18, 23, 30);
const LIST = 'aaaaaaaa-1111-4111-8111-111111111111';
const FOREIGN = 'eeeeeeee-9999-4999-8999-999999999999';
const MADE = 'dddddddd-0000-4000-8000-000000000001';

/** A fake store. `newOnly` answers the new-only route; return a full { ok, status, data } or a function of the body. */
function backend({ lists = [{ id: LIST, name: 'plant shop owners' }], newOnly, knownPerson } = {}) {
  const state = { calls: [], refs: new Map() };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    const p = new URL(pathname, 'https://x.test').pathname;
    state.calls.push({ method, path: p, url: pathname, body: options.body });
    if (method === 'GET' && p === '/nexus/lists') return answer(200, { lists });
    if (method === 'POST' && p === '/nexus/people/search') return answer(200, { people: [], total: 0 });
    if (method === 'POST' && p === '/nexus/lists') return answer(200, { list: { id: LIST, name: options.body.name, count: 0 } });
    if (method === 'POST' && p === '/integrations/google/known-person') {
      return knownPerson ? knownPerson(options.body) : answer(200, { status: 'clear', checked: { gmail: 3, calendar: 2, contacts: 5 }, contacts_scope: 'connected' });
    }
    if (method === 'POST' && p === '/nexus/capture/new-only') {
      if (typeof newOnly === 'function') return newOnly(options.body, state);
      if (newOnly) return newOnly;
      if (state.refs.has(options.body.ref)) return answer(200, { status: 'replayed', person_id: state.refs.get(options.body.ref) });
      state.refs.set(options.body.ref, MADE);
      return answer(200, { status: 'created', person_id: MADE });
    }
    return answer(404, { detail: 'Not Found' });
  };
  return { state, request };
}

function runner(server, opts = {}) {
  const { at = START, screen } = opts;
  const account = 'account' in opts ? opts.account : 'acct-a';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hour-new-only-'));
  const file = path.join(dir, 'hour.json');
  let now = at;
  const screens = [];
  const go = async (args, { as = account, token = 't' } = {}) => {
    const out = [];
    const errs = [];
    const deps = {
      log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => now, env: {}, hourFile: file,
      getToken: async () => ({ token, ...(as === undefined ? {} : { account: as }) }), apiRequestJson: server.request,
      ...(opts.realScreen ? {} : { screenNewProspect: async (input) => {
        screens.push({ ...input, callsBefore: server.state.calls.length });
        return screen ? screen(input) : { status: 'clear' };
      } }),
      client: () => ({ read: async () => { throw new Error('never read'); }, write: async () => { throw new Error('never written'); } }),
    };
    const code = await nexusCommand(['hour', ...args], deps);
    return { code, out: out.join('\n'), err: errs.join('\n') };
  };
  go.later = (minutes) => { now = new Date(now.getTime() + minutes * 60000); };
  go.file = file;
  go.screens = screens;
  go.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return go;
}

const ADD = ['add', 'Rae Sample', '--email', 'rae@example.com', '--company', 'Fern & Co', '--source', 'https://example.com/fern', '--why', 'posts about weekend orders'];

/** Nothing outside the new-only route ever changes a card or a list. */
function noLegacyMutation(server) {
  for (const c of server.state.calls) {
    assert.ok(!(c.method === 'POST' && c.path === '/nexus/capture'), 'never the old add');
    assert.ok(!(c.method === 'POST' && /^\/nexus\/lists\/[^/]+\/people$/.test(c.path)), 'never puts anyone on a list itself');
    assert.ok(!(c.method === 'PATCH' && /\/mine$/.test(c.path)), 'never changes a card itself');
    assert.doesNotMatch(c.path, /\/(send|reply)$/, 'never sends');
    for (const secret of ['Rae', 'Sample', 'example.com', 'weekend']) assert.ok(!c.url.includes(secret), `${secret} never sits in a web address`);
  }
}

const mutations = (server) => server.state.calls.filter((c) => c.method !== 'GET');

async function strictHour(server, opts) {
  const go = runner(server, opts);
  const r = await go(['start', 'plant shop owners', '--guess', 'one in five reply', '--new-only']);
  assert.equal(r.code, 0, r.err);
  server.state.calls.length = 0;
  return go;
}

test('help names --new-only on start and add', async () => {
  const go = runner(backend());
  const r = await go(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /atris nexus hour start \.\.\. --new-only/);
  assert.match(r.out, /atris nexus hour add "<name>" --new-only --source <url> --why/);
  go.cleanup();
});

test('a new-only start keeps the mode and a one-way account mark on the clock; a plain start keeps neither', async () => {
  const go = runner(backend());
  const r = await go(['start', 'plant shop owners', '--guess', 'g', '--new-only', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).new_only, true);
  const clock = JSON.parse(fs.readFileSync(go.file, 'utf8'));
  assert.equal(clock.mode, 'new_only');
  assert.match(clock.account, /^[0-9a-f]{32}$/);
  assert.ok(!fs.readFileSync(go.file, 'utf8').includes('acct-a'), 'the account id itself is never written down');
  const status = await go(['--json']);
  assert.equal(JSON.parse(status.out).new_only, true);
  go.cleanup();

  const plain = runner(backend());
  assert.equal((await plain(['start', 'plant shop owners', '--guess', 'g'])).code, 0);
  const old = JSON.parse(fs.readFileSync(plain.file, 'utf8'));
  assert.equal(old.mode, undefined);
  assert.equal(old.account, undefined);
  plain.cleanup();
});

test('a new-only add screens first, then makes one call that does everything, with the exact fields', async () => {
  const server = backend();
  const go = await strictHour(server);
  const r = await go([...ADD, '--title', 'Owner', '--city', 'Austin', '--site', 'https://fern.example.com', '--linkedin', 'https://linkedin.com/in/rae-sample', '--x', 'raesample', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, did: 'add', new_only: true, status: 'created', id: MADE, list_id: LIST });
  assert.equal(go.screens.length, 1);
  assert.equal(go.screens[0].name, 'Rae Sample');
  assert.equal(go.screens[0].email, 'rae@example.com');
  assert.equal(go.screens[0].token, 't');
  assert.equal(go.screens[0].request, server.request);
  const posts = mutations(server);
  assert.equal(posts.length, 1, 'one write only');
  assert.equal(posts[0].path, '/nexus/capture/new-only');
  assert.ok(go.screens[0].callsBefore < server.state.calls.indexOf(posts[0]) + 1, 'the screen ran before the write');
  const { ref, ...rest } = posts[0].body;
  assert.match(ref, /^hour-new-[0-9a-f]{40}$/);
  assert.deepEqual(rest, {
    name: 'Rae Sample', email: 'rae@example.com', company: 'Fern & Co', title: 'Owner', city: 'Austin',
    website: 'https://fern.example.com', linkedin_url: 'https://linkedin.com/in/rae-sample', x: 'raesample',
    source_url: 'https://example.com/fern', words: 'Why reach out: posts about weekend orders\nSource: https://example.com/fern', list_id: LIST, source: 'command_line',
  });
  noLegacyMutation(server);
  go.cleanup();
});

test('fields that were not given are left out', async () => {
  const server = backend();
  const go = await strictHour(server);
  const r = await go(['add', 'Bo Lane', '--source', 'https://example.org/b', '--why', 'opened a second shop']);
  assert.equal(r.code, 0, r.err);
  const body = mutations(server)[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['list_id', 'name', 'ref', 'source', 'source_url', 'words']);
  assert.equal(go.screens[0].email, null);
  go.cleanup();
});

test('refusals make no call and leave the clock as it was', async () => {
  const server = backend();
  const go = await strictHour(server);
  const before = fs.readFileSync(go.file, 'utf8');
  const cases = [
    [[...ADD, '--person', MADE], /neither --person nor --new/],
    [[...ADD, '--new'], /neither --person nor --new/],
    [['add', 'Rae Sample', '--why', 'w'], /needs the page you found them on/],
    [['add', 'Rae Sample', '--source', 'a friend told me', '--why', 'w'], /web address/],
    [['add', 'Rae Sample', '--source', 'https://example.com/a'], /needs the one reason/],
    [['add', 'Rae Sample', '--source', 'https://example.com/a', '--why', 'x'.repeat(501)], /under 500/],
    [['next', '--new-only'], /goes with start or add/],
    [['research', 'Rae', '--level', '1', '--source', 'https://example.com/a', '--title', 'Owner'], /go with a new-only add/],
  ];
  for (const [args, said] of cases) {
    const r = await go(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, said);
  }
  assert.equal(server.state.calls.length, 0);
  assert.equal(go.screens.length, 0);
  assert.equal(fs.readFileSync(go.file, 'utf8'), before);
  go.cleanup();

  const plain = runner(backend());
  const r = await plain(['start', 'florists', '--guess', 'g', '--new-only', '--new']);
  assert.equal(r.code, 2);
  assert.equal(fs.existsSync(plain.file), false);
  plain.cleanup();
});

test('a new-only hour cannot be turned back: an add without the flag still goes the new-only way', async () => {
  const server = backend();
  const go = await strictHour(server);
  const r = await go(['add', 'Rae Sample', '--source', 'https://example.com/fern', '--why', 'w']);
  assert.equal(r.code, 0, r.err);
  assert.equal(mutations(server)[0].path, '/nexus/capture/new-only');
  const bare = await go(['add', 'Rae Sample', '--email', 'rae@example.com']);
  assert.equal(bare.code, 2, 'the old add is refused, not run');
  assert.match(bare.err, /needs the page you found them on/);
  const second = await go(['start', 'bakers', '--guess', 'g']);
  assert.equal(second.code, 1, 'a plain start cannot replace a running new-only hour');
  assert.equal(JSON.parse(fs.readFileSync(go.file, 'utf8')).mode, 'new_only');
  noLegacyMutation(server);
  go.cleanup();
});

test('a clock with a mode this version does not know, or no account, adds nothing', async () => {
  for (const extra of [{ mode: 'stricter', account: 'x'.repeat(32) }, { mode: 'new_only' }]) {
    const server = backend();
    const go = runner(server);
    fs.writeFileSync(go.file, JSON.stringify({ list_id: LIST, cluster: 'c', started_at: START.toISOString(), ends_at: new Date(START.getTime() + 3600000).toISOString(), ...extra }));
    const r = await go(ADD);
    assert.equal(r.code, 1);
    assert.equal(server.state.calls.length, 0);
    go.cleanup();
  }
});

test('never falls back to the old add, whatever Nexus answers', async () => {
  const answers = [
    [{ ok: false, status: 404, data: { detail: 'Not Found' } }, /could not find the list or the new-only capture endpoint/],
    [{ ok: false, status: 405, data: {} }, /does not support adding only new people/],
    [{ ok: false, status: 500, data: {} }, /Run the same command again/],
    [{ ok: false, status: 0, data: null }, /Run the same command again/],
    [{ ok: false, status: 409, data: { detail: 'That list is not yours.' } }, /not yours/],
    [{ ok: true, status: 200, data: { status: 'made', person_id: MADE } }, /did not say whether/],
    [{ ok: true, status: 200, data: { status: 'created', person_id: 'nope' } }, /did not say whether/],
    [{ ok: true, status: 200, data: { status: 'replayed' } }, /did not say whether/],
    [{ ok: true, status: 200, data: null }, /did not say whether/],
  ];
  for (const [given, said] of answers) {
    const server = backend({ newOnly: given });
    const go = await strictHour(server);
    const r = await go([...ADD, '--json']);
    assert.equal(r.code, 1, JSON.stringify(given));
    const body = JSON.parse(r.out);
    assert.equal(body.ok, false);
    assert.match(body.error, said);
    assert.equal(mutations(server).length, 1, 'only the one new-only call');
    noLegacyMutation(server);
    go.cleanup();
  }
});

test('skipped by Nexus: no id shown and nothing else changes', async () => {
  const server = backend({ newOnly: { ok: true, status: 200, data: { status: 'skipped', person_id: MADE } } });
  const go = await strictHour(server);
  const r = await go(ADD);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /already has a card in your Nexus, so they were skipped\. Nothing was added or changed/);
  assert.ok(!r.out.includes(MADE.slice(0, 8)), 'a known card id is never shown');
  const j = await go([...ADD, '--json']);
  assert.deepEqual(JSON.parse(j.out), { ok: true, did: 'add', new_only: true, status: 'skipped', list_id: LIST, skipped_by: 'nexus' });
  noLegacyMutation(server);
  go.cleanup();
});

test('the screen decides first: matched skips, anything but clear stops, and neither one writes', async () => {
  const verdicts = [
    [() => ({ status: 'matched' }), 0],
    [() => ({ status: 'unavailable' }), 1],
    [() => ({ status: 'maybe' }), 1],
    [() => null, 1],
    [() => { throw new Error('boom'); }, 1],
  ];
  for (const [screen, code] of verdicts) {
    const server = backend();
    const go = await strictHour(server, { screen });
    const r = await go([...ADD, '--json']);
    assert.equal(r.code, code, String(screen));
    const body = JSON.parse(r.out);
    if (code === 0) assert.deepEqual([body.status, body.skipped_by], ['skipped', 'correspondence']);
    else assert.match(body.error, /could not verify this person/);
    assert.equal(mutations(server).length, 0, 'no write at all');
    go.cleanup();
  }
});

test('asking twice sends the same ref, even past midnight, and the second answer is a replay', async () => {
  const server = backend();
  const go = await strictHour(server);
  const first = await go(ADD);
  assert.equal(first.code, 0, first.err);
  go.later(45);
  const again = await go(ADD);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /Nothing was added twice/);
  const refs = mutations(server).map((c) => c.body.ref);
  assert.equal(refs.length, 2);
  assert.equal(refs[0], refs[1], 'the same ask carries the same ref across midnight');
  assert.equal(server.state.refs.size, 1);
  const other = await go(['add', 'Cy Moss', '--source', 'https://example.com/c', '--why', 'w']);
  assert.equal(other.code, 0);
  assert.notEqual(mutations(server)[2].body.ref, refs[0]);
  noLegacyMutation(server);
  go.cleanup();
});

test('a different signed-in account cannot add to the hour another account started', async () => {
  const server = backend();
  const go = await strictHour(server);
  const r = await go(ADD, { as: 'acct-b' });
  assert.equal(r.code, 1);
  assert.match(r.err, /different account is signed in/);
  assert.equal(server.state.calls.length, 0);
  assert.equal(go.screens.length, 0);
  go.cleanup();
});

test('the account can come from the login itself, and with no account at all nothing starts', async () => {
  const jwt = (sub) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  const server = backend();
  const go = runner(server, { account: undefined });
  assert.equal((await go(['start', 'florists', '--guess', 'g', '--new-only'], { token: jwt('user-1') })).code, 0);
  assert.equal((await go(ADD, { token: jwt('user-1') })).code, 0);
  const r = await go(ADD, { token: jwt('user-2') });
  assert.equal(r.code, 1);
  assert.match(r.err, /different account/);
  go.cleanup();

  const none = runner(backend(), { account: undefined });
  const s = await none(['start', 'florists', '--guess', 'g', '--new-only']);
  assert.equal(s.code, 1);
  assert.match(s.err, /Could not tell which account/);
  assert.equal(fs.existsSync(none.file), false);
  none.cleanup();
});

test('on an older clock, a new-only add checks the list belongs to whoever is signed in and leaves the clock alone', async () => {
  const server = backend({ lists: [{ id: FOREIGN, name: 'someone else' }] });
  const go = runner(server);
  const old = JSON.stringify({ list_id: LIST, cluster: 'c', started_at: START.toISOString(), ends_at: new Date(START.getTime() + 3600000).toISOString() });
  fs.writeFileSync(go.file, old);
  const r = await go([...ADD, '--new-only']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not one of the signed-in account's saved lists/);
  assert.equal(mutations(server).length, 0);
  assert.equal(go.screens.length, 0);
  assert.equal(fs.readFileSync(go.file, 'utf8'), old, 'the older clock is unchanged');
  go.cleanup();

  const ok = backend();
  const go2 = runner(ok);
  fs.writeFileSync(go2.file, old);
  const r2 = await go2([...ADD, '--new-only']);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(mutations(ok)[0].path, '/nexus/capture/new-only');
  assert.equal(fs.readFileSync(go2.file, 'utf8'), old);
  noLegacyMutation(ok);
  go2.cleanup();
});

test('on an older clock, a plain add still goes the old way', async () => {
  const calls = [];
  const request = async (pathname, options = {}) => {
    calls.push({ method: options.method || 'GET', path: pathname });
    if (pathname === '/nexus/capture') return { ok: true, status: 200, data: { person_id: MADE, made: true } };
    return { ok: true, status: 200, data: {} };
  };
  const go = runner({ request, state: { calls } });
  fs.writeFileSync(go.file, JSON.stringify({ list_id: LIST, cluster: 'c', started_at: START.toISOString(), ends_at: new Date(START.getTime() + 3600000).toISOString() }));
  const r = await go(['add', 'Rae Sample', '--email', 'rae@example.com', '--source', 'https://example.com/fern']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /nexus/capture', `POST /nexus/lists/${LIST}/people`, `PATCH /nexus/people/${MADE}/mine`,
  ]);
  assert.equal(go.screens.length, 0, 'the old way does not run the screen');
  go.cleanup();
});

test('with the real check: it runs before the write, and what it looked through is shown', async () => {
  const server = backend();
  const go = await strictHour(server, { realScreen: true });
  const r = await go([...ADD, '--json']);
  assert.equal(r.code, 0, r.err);
  const body = JSON.parse(r.out);
  assert.equal(body.status, 'created');
  assert.deepEqual(body.checked, { gmail: 3, calendar: 2, contacts: 5 });
  assert.equal(body.contacts_scope, 'connected');
  const paths = server.state.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.indexOf('POST /integrations/google/known-person') < paths.indexOf('POST /nexus/capture/new-only'));
  const text = await go(['add', 'Cy Moss', '--source', 'https://example.com/c', '--why', 'w']);
  assert.match(text.out, /Checked 3 mailboxes, 2 calendars, 5 Google Contacts accounts/);
  noLegacyMutation(server);
  go.cleanup();
});

test('with the real check: a known person or a check that cannot answer writes nothing', async () => {
  const cases = [
    [() => ({ ok: true, status: 200, data: { status: 'matched', checked: { gmail: 1, calendar: 0, contacts: 0 }, contacts_scope: 'not_connected' } }), 0, /already in your email, calendar or contacts[\s\S]*Checked 1 mailbox\.[\s\S]*Google Contacts was not checked/],
    [() => ({ ok: false, status: 404, data: { detail: 'Not Found' } }), 1, /could not verify this person/],
    [() => ({ ok: true, status: 200, data: { status: 'clear' } }), 1, /could not verify this person/],
  ];
  for (const [knownPerson, code, said] of cases) {
    const server = backend({ knownPerson });
    const go = await strictHour(server, { realScreen: true });
    const r = await go(ADD);
    assert.equal(r.code, code, r.err);
    assert.match(code ? r.err : r.out, said);
    assert.equal(server.state.calls.filter((c) => c.path === '/nexus/capture/new-only').length, 0);
    noLegacyMutation(server);
    go.cleanup();
  }
});

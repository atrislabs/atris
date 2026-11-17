'use strict';

// atris nexus hour, with every backend call and the clock faked. Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { nexusCommand } = require('../commands/nexus');

const START = new Date(2026, 10, 16, 9, 0);
const LIST = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';
const RAE = '11111111-0000-4000-8000-00000000000a';
const BO = '22222222-0000-4000-8000-00000000000b';
const CY = '33333333-0000-4000-8000-00000000000c';
const DI = '44444444-0000-4000-8000-00000000000d';

function card(pid, name, extra = {}, over = {}) {
  return { id: pid, mine: true, name, company_name: null, location_raw: null, website: null, private: { stage: 'found', email: `${name.split(' ')[0].toLowerCase()}@example.com`, extra, ...over } };
}
const research = (level, confidence, hook = 'Posted about weekend orders piling up') => ({
  col_research_level: { v: level, by: 'you', at: 'x', src: 'https://example.com/a' },
  ...(confidence === undefined ? {} : { col_confidence: { v: confidence, by: 'you', at: 'x', src: 'https://example.com/a' } }),
  col_hook: { v: hook, by: 'you', at: 'x', src: 'https://example.com/a' },
});

/** A fake store. `live` turns on the routes that are still landing. */
function backend({ live = false, lists = [], people = [], members = {}, drafts = {} } = {}) {
  const state = { calls: [], lists: lists.map((l) => ({ ...l })), people, members: { ...members }, drafts: { ...drafts }, experiments: {}, nextId: 1 };
  const answer = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const notThere = () => answer(404, { detail: 'Not Found' });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    const url = new URL(pathname, 'https://x.test');
    state.calls.push({ method, url: pathname, path: url.pathname, body: options.body });
    const p = url.pathname;
    let m;
    if (method === 'GET' && p === '/nexus/lists') {
      return answer(200, { lists: state.lists.map((l) => ({ ...l, count: (state.members[l.id] || []).length })) });
    }
    if (method === 'POST' && p === '/nexus/lists') {
      const made = { id: `cccccccc-0000-4000-8000-00000000000${state.nextId++}`, name: options.body.name };
      state.lists.push(made);
      state.members[made.id] = [];
      return answer(200, { list: { ...made, count: 0 }, skipped: 0, replayed: false });
    }
    if (method === 'POST' && (m = /^\/nexus\/lists\/([^/]+)\/people$/.exec(p))) {
      const now = state.members[m[1]] || [];
      for (const pid of options.body.add || []) if (!now.includes(pid)) now.push(pid);
      state.members[m[1]] = now;
      return answer(200, { list: { id: m[1], count: now.length }, skipped: 0 });
    }
    if (method === 'POST' && p === '/nexus/people/search') {
      const ids = options.body.list_id ? (state.members[options.body.list_id] || []) : state.people.map((c) => c.id);
      const hits = state.people.filter((c) => ids.includes(c.id));
      const off = options.body.offset || 0;
      return answer(200, { people: hits.slice(off, off + options.body.limit), total: hits.length });
    }
    if (method === 'POST' && p === '/nexus/capture') {
      const pid = `dddddddd-0000-4000-8000-00000000000${state.nextId++}`;
      state.people.push({ id: pid, mine: true, name: options.body.name, company_name: options.body.company || null, private: { stage: 'found', email: options.body.email || null, extra: {} } });
      return answer(200, { person_id: pid, name: options.body.name, made: true, matched_by: null });
    }
    if (method === 'PATCH' && (m = /^\/nexus\/people\/([^/]+)\/mine$/.exec(p))) {
      const c = state.people.find((x) => x.id === m[1]);
      const extra = { ...c.private.extra };
      for (const [k, v] of Object.entries(options.body.extra || {})) if (v === null) delete extra[k]; else extra[k] = v;
      c.private = { ...c.private, extra };
      return answer(200, { card: c });
    }
    if (!live) return notThere();
    if (method === 'PATCH' && (m = /^\/nexus\/lists\/([^/]+)\/experiment$/.exec(p))) {
      state.experiments[m[1]] = { ...(state.experiments[m[1]] || {}), ...options.body };
      return answer(200, { list: { id: m[1] }, experiment: state.experiments[m[1]] });
    }
    if (method === 'GET' && (m = /^\/nexus\/lists\/([^/]+)\/score$/.exec(p))) {
      const ids = state.members[m[1]] || [];
      const rows = ids.map((pid) => ({ person_id: pid, reached: pid === DI, replied: pid === DI }));
      return answer(200, { list: { id: m[1] }, experiment: state.experiments[m[1]] || null, counts: { people: ids.length, reached: rows.filter((r) => r.reached).length, replied: rows.filter((r) => r.replied).length }, rates: {}, people: rows });
    }
    if (method === 'GET' && (m = /^\/nexus\/lists\/([^/]+)\/drafts$/.exec(p))) {
      const ids = state.members[m[1]] || [];
      const ds = ids.filter((pid) => state.drafts[pid]).map((pid) => ({ person_id: pid, ...state.drafts[pid] }));
      return answer(200, { count: ds.length, without_draft: ids.length - ds.length, drafts: ds });
    }
    if (method === 'PUT' && (m = /^\/nexus\/people\/([^/]+)\/draft$/.exec(p))) {
      if (/\bai\b/i.test(options.body.body)) return answer(422, { detail: 'Nothing was saved: the draft uses the word "AI". Notes never say AI, agent or automate. Say what you do for them in plain words instead.' });
      state.drafts[m[1]] = { subject: options.body.subject, body: options.body.body, step: options.body.step };
      return answer(200, { draft: { person_id: m[1] } });
    }
    return notThere();
  };
  return { state, request };
}

function tmpClock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hour-'));
  return { dir, file: path.join(dir, 'hour.json') };
}

function runner(server, { at = START, env = {} } = {}) {
  const clock = tmpClock();
  let now = at;
  const go = async (args) => {
    const out = [];
    const errs = [];
    const code = await nexusCommand(['hour', ...args], {
      log: (l) => out.push(String(l)), err: (l) => errs.push(String(l)), now: () => now, env, hourFile: clock.file,
      getToken: async () => ({ token: 't' }), apiRequestJson: server.request,
      client: () => ({ read: async () => { throw new Error('the saved list is never read'); }, write: async () => { throw new Error('never written'); } }),
    });
    return { code, out: out.join('\n'), err: errs.join('\n') };
  };
  go.later = (minutes) => { now = new Date(now.getTime() + minutes * 60000); };
  go.clock = clock;
  go.cleanup = () => fs.rmSync(clock.dir, { recursive: true, force: true });
  return go;
}

// Every test: nothing sends. No name, search word or note text ever sits in a web address.
function noSendsAndCleanUrls(server, secrets = []) {
  for (const call of server.state.calls) {
    assert.doesNotMatch(call.path, /\/(send|reply)$/, `no send route is ever called: ${call.path}`);
    for (const s of secrets) assert.ok(!call.url.toLowerCase().includes(String(s).toLowerCase()), `"${s}" never goes in a web address`);
  }
}

const SECRETS = ['Rae', 'Sample', 'plant', 'guess', 'orders', 'example.com', 'Hey'];

test('start needs a guess and makes no call without one', async () => {
  const server = backend();
  const go = runner(server);
  const r = await go(['start', 'plant shop owners']);
  assert.equal(r.code, 2);
  assert.match(r.err, /No test without a guess behind it/);
  assert.equal(server.state.calls.length, 0);
  assert.equal(fs.existsSync(go.clock.file), false);
  go.cleanup();
});

test('start reuses a saved list with the same name in any case and keeps the guess on it', async () => {
  const server = backend({ live: true, lists: [{ id: LIST, name: 'Plant Shop Owners' }], people: [card(RAE, 'Rae Sample')], members: { [LIST]: [RAE] } });
  const go = runner(server);
  const r = await go(['start', 'plant shop owners', '--guess', 'one in five owners reply to a two line note']);
  assert.equal(r.code, 0, r.err);
  assert.equal(server.state.calls.filter((c) => c.method === 'POST' && c.path === '/nexus/lists').length, 0, 'no new list');
  assert.deepEqual(server.state.experiments[LIST], { guess: 'one in five owners reply to a two line note', started_at: '2026-11-16' });
  const clock = JSON.parse(fs.readFileSync(go.clock.file, 'utf8'));
  assert.equal(clock.list_id, LIST);
  assert.equal(clock.ends_at, new Date(START.getTime() + 3600000).toISOString());
  assert.equal(clock.guess, undefined, 'the guess lives in Nexus when Nexus can keep it');
  assert.match(r.out, /It runs on your saved list "Plant Shop Owners", 1 person on it/);
  noSendsAndCleanUrls(server, SECRETS);
  go.cleanup();
});

test('start makes a new list for a new cluster', async () => {
  const server = backend({ live: true });
  const go = runner(server);
  const r = await go(['start', 'plant shop owners', '--guess', 'owners answer', '--minutes', '30', '--json']);
  assert.equal(r.code, 0, r.err);
  const body = JSON.parse(r.out);
  assert.equal(body.list.made, true);
  assert.equal(body.minutes, 30);
  const made = server.state.calls.find((c) => c.method === 'POST' && c.path === '/nexus/lists');
  assert.equal(made.body.name, 'plant shop owners');
  assert.deepEqual(made.body.person_ids, []);
  go.cleanup();
});

test('--list starts an hour on a list that already exists, by name or id', async () => {
  const server = backend({ live: true, lists: [{ id: OTHER, name: 'rainmaker' }] });
  const go = runner(server);
  const r = await go(['start', '--list', 'rainmaker', '--guess', 'warm intros reply twice as often']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(go.clock.file, 'utf8')).list_id, OTHER);
  assert.equal(JSON.parse(fs.readFileSync(go.clock.file, 'utf8')).cluster, 'rainmaker');
  go.cleanup();

  const go2 = runner(backend({ lists: [{ id: OTHER, name: 'rainmaker' }] }));
  const missing = await go2(['start', '--list', 'nope', '--guess', 'x']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /None of your saved lists/);
  go2.cleanup();
});

test('a second start is refused and says how to end the first', async () => {
  const server = backend({ live: true });
  const go = runner(server);
  assert.equal((await go(['start', 'florists', '--guess', 'g'])).code, 0);
  const calls = server.state.calls.length;
  go.later(15);
  const r = await go(['start', 'bakers', '--guess', 'g']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already running, 45 minutes left\. End it first: atris nexus hour end/);
  assert.equal(server.state.calls.length, calls, 'refused before any call');
  go.cleanup();
});

test('add captures the person, puts them on the list and marks an unsourced email unconfirmed', async () => {
  const server = backend({ live: true });
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'g']);
  const listId = JSON.parse(fs.readFileSync(go.clock.file, 'utf8')).list_id;
  const r = await go(['add', 'Rae Sample', '--email', 'rae@example.com', '--company', 'Fern & Co', '--why', 'Posted about weekend orders']);
  assert.equal(r.code, 0, r.err);
  const captured = server.state.calls.find((c) => c.path === '/nexus/capture');
  assert.equal(captured.body.name, 'Rae Sample');
  assert.equal(captured.body.email, 'rae@example.com');
  assert.equal(captured.body.source, 'command_line');
  const pid = server.state.people[0].id;
  assert.deepEqual(server.state.members[listId], [pid]);
  assert.equal(server.state.people[0].private.extra.col_email_status.v, 'unconfirmed');
  assert.match(r.out, /marked unconfirmed/);

  const sourced = await go(['add', 'Bo Example', '--email', 'bo@example.com', '--source', 'https://example.com/contact', '--json']);
  assert.equal(JSON.parse(sourced.out).email, 'read on a page');
  assert.equal(server.state.people[1].private.extra.col_email_status.src, 'https://example.com/contact');
  noSendsAndCleanUrls(server, [...SECRETS, 'Bo', 'Fern']);
  go.cleanup();
});

function workedList(live = true) {
  return backend({
    live,
    lists: [{ id: LIST, name: 'plant shop owners' }],
    people: [
      card(RAE, 'Rae Sample', research(2, 80)), // confident, no draft
      card(BO, 'Bo Example', research(1, 60)), // level 1 only
      card(CY, 'Cy Person'), // no research
      card(DI, 'Di Reached', research(2, 90), { stage: 'reached_out' }),
    ],
    members: { [LIST]: [RAE, BO, CY, DI] },
  });
}

test('next picks no research first, then level 1 only, then confident with no note', async () => {
  const server = workedList();
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'g']);
  let r = await go(['next', '--json']);
  let body = JSON.parse(r.out);
  assert.equal(body.person.name, 'Cy Person');
  assert.equal(body.why, 'no research yet');
  assert.ok(body.missing.includes('level 1 research (the business)'));

  server.state.people.find((c) => c.id === CY).private.extra = research(2, 40);
  body = JSON.parse((await go(['next', '--json'])).out);
  assert.equal(body.person.name, 'Bo Example');

  server.state.people.find((c) => c.id === BO).private.extra = research(2, 50);
  r = await go(['next']);
  assert.match(r.out, /^Next: Rae Sample \(confident, with no note stored\)/);
  assert.match(r.out, /atris nexus hour draft "Rae Sample"/);
  go.cleanup();
});

test('research is refused without a source and records level, confidence and the reason with it', async () => {
  const server = workedList();
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'g']);
  const before = server.state.calls.length;
  const refused = await go(['research', 'Cy Person', '--level', '1', '--confidence', '80', '--why', 'x']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--source/);
  assert.equal(server.state.calls.length, before, 'refused before any call');

  const r = await go(['research', 'Cy', '--level', '2', '--confidence', '74', '--source', 'https://example.com/about', '--why', 'Runs the shop alone since 2019']);
  assert.equal(r.code, 0, r.err);
  const extra = server.state.people.find((c) => c.id === CY).private.extra;
  assert.equal(extra.col_research_level.v, 2);
  assert.equal(extra.col_confidence.v, 74);
  assert.equal(extra.col_hook.v, 'Runs the shop alone since 2019');
  for (const k of ['col_research_level', 'col_confidence', 'col_hook']) assert.equal(extra[k].src, 'https://example.com/about');
  assert.equal(extra.col_confidence.by, 'you');
  assert.match(r.out, /Below 75, so no note goes to them this hour/);
  noSendsAndCleanUrls(server, [...SECRETS, 'Cy', 'Runs the shop']);
  go.cleanup();
});

test('ready needs 75 or more, level 2 and a stored note; 74 is not ready. Sending stays the owner\'s press', async () => {
  const server = workedList();
  server.state.drafts[RAE] = { subject: 'weekend orders', body: 'Hey Rae', step: 1 };
  server.state.drafts[BO] = { subject: 's', body: 'Hey Bo', step: 1 }; // level 1, so not ready
  server.state.people.find((c) => c.id === CY).private.extra = research(2, 74);
  server.state.drafts[CY] = { subject: 's', body: 'Hey Cy', step: 1 };
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'g']);
  let body = JSON.parse((await go(['ready', '--json'])).out);
  assert.equal(body.sending, 'owner');
  assert.deepEqual(body.ready.map((p) => p.name), ['Rae Sample'], 'Di was reached already; Bo is level 1; Cy is 74');
  assert.equal(body.ready[0].command, `open https://atris.ai/dashboard/nexus/${RAE.replace(/-/g, '').slice(0, 8)}`);

  server.state.people.find((c) => c.id === CY).private.extra = research(2, 75);
  const r = await go(['ready']);
  assert.match(r.out, /^Sending is your press\. Nothing here sends anything/);
  assert.match(r.out, /Cy Person, confidence 75/);
  assert.match(r.out, /Reason: Posted about weekend orders piling up/);
  noSendsAndCleanUrls(server, SECRETS);
  go.cleanup();
});

test('draft stores the note through the draft route and passes a refusal through as is', async () => {
  const server = workedList();
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'g']);
  const note = path.join(go.clock.dir, 'note.txt');
  fs.writeFileSync(note, 'Hey Rae,\nSaw the weekend orders post. Fifty a month takes the late ones off your plate. Worth a look?\n');
  const r = await go(['draft', 'Rae Sample', '--subject', 'weekend orders', '--body-file', note]);
  assert.equal(r.code, 0, r.err);
  const put = server.state.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, `/nexus/people/${RAE}/draft`);
  assert.equal(put.body.list_id, LIST);
  assert.equal(put.body.step, 1);
  assert.match(put.body.body, /^Hey Rae,/);
  assert.match(r.out, /Nothing was sent/);

  fs.writeFileSync(note, 'Hey Rae, our AI does it.');
  const refused = await go(['draft', 'Rae Sample', '--subject', 'x', '--body-file', note]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^Nothing was saved: the draft uses the word "AI"\./);
  noSendsAndCleanUrls(server, SECRETS);
  go.cleanup();
});

test('every route still landing answers 404: one plain line each. Every screen still prints', async () => {
  const server = workedList(false);
  const go = runner(server);
  const started = await go(['start', 'plant shop owners', '--guess', 'owners reply']);
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /Keeping the guess on the list in Nexus is not live yet/);
  assert.equal(JSON.parse(fs.readFileSync(go.clock.file, 'utf8')).guess, 'owners reply', 'kept with the clock until Nexus can');

  go.later(19);
  const status = await go([]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /^GTM hour: plant shop owners/);
  assert.match(status.out, /41 minutes left, minute 19 of 60\. Next research pass at minute 20\./);
  assert.match(status.out, /Guess: owners reply/);
  assert.match(status.out, /on list\s+level 1\s+level 2\s+confident\s+drafted\s+ready\s+reached\s+replied/);
  assert.match(status.out, /\n {2}4\s+3\s+2\s+2\s+0\s+0\s+1\s+0\n/, 'reached comes from the stage when scores are not live');
  assert.match(status.out, /Reply numbers from Nexus are not live yet/);
  assert.match(status.out, /Notes stored per person are not live yet/);
  assert.match(status.out, /Next: Research Cy Person's business\./);

  for (const sub of ['next', 'ready']) {
    const r = await go([sub]);
    assert.equal(r.code, 0, `${sub}: ${r.err}`);
  }
  const note = path.join(go.clock.dir, 'n.txt');
  fs.writeFileSync(note, 'Hey Rae, short note.');
  const draft = await go(['draft', 'Rae Sample', '--subject', 's', '--body-file', note]);
  assert.equal(draft.code, 1);
  assert.equal(draft.err, 'Storing a note per person is not live yet, so nothing was stored.');

  const end = await go(['end', '--learned', 'owners with a phone number on the site answer first', '--json']);
  assert.equal(end.code, 0, end.err);
  const body = JSON.parse(end.out);
  assert.equal(body.learned_saved, false);
  assert.ok(body.not_live.includes('learned'));
  assert.equal(body.reply_numbers, 'stages');
  noSendsAndCleanUrls(server, SECRETS);
  go.cleanup();
});

test('status with live scores uses the real reply numbers. --json gives one object', async () => {
  const server = workedList(true);
  server.state.drafts[RAE] = { subject: 's', body: 'b' };
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'owners reply']);
  const body = JSON.parse((await go(['--json'])).out);
  assert.equal(body.running, true);
  assert.equal(body.guess, 'owners reply');
  assert.deepEqual(body.counts, { on_list: 4, level_1: 3, level_2: 2, confident: 2, drafted: 1, ready: 1, reached: 1, replied: 1 });
  assert.equal(body.next.command, 'atris nexus hour ready');
  assert.deepEqual(body.not_live, []);
  go.cleanup();
});

test('end saves what was learned, prints the follow-ups and clears the clock', async () => {
  const server = workedList(true);
  server.state.people.find((c) => c.id === DI).private.due_on = '2026-11-20';
  server.state.people.find((c) => c.id === DI).private.next_move = 'Follow up 2 of 3';
  const go = runner(server);
  await go(['start', 'plant shop owners', '--guess', 'owners reply']);
  go.later(62);
  const status = await go([]);
  assert.match(status.out, /Time is up/);
  assert.match(status.out, /atris nexus hour end --learned/);
  const r = await go(['end', '--learned', 'the phone number on the site matters']);
  assert.equal(r.code, 0, r.err);
  assert.equal(server.state.experiments[LIST].learned, 'the phone number on the site matters');
  assert.match(r.out, /over after 60 minutes/);
  assert.match(r.out, /Result: 4 on the list, 2 researched to the person, 0 ready, 1 reached, 1 replied\./);
  assert.match(r.out, /2026-11-20 {2}Di Reached: Follow up 2 of 3/);
  assert.equal(fs.existsSync(go.clock.file), false);
  const again = await go([]);
  assert.match(again.out, /No hour is running/);
  noSendsAndCleanUrls(server, SECRETS);
  go.cleanup();
});

test('an unknown flag is refused before anything is changed', async () => {
  const server = backend();
  const go = runner(server);
  const r = await go(['start', 'x', '--gues', 'typo']);
  assert.equal(r.code, 2);
  assert.match(r.err, /does not take --gues/);
  assert.equal(server.state.calls.length, 0);
  go.cleanup();
});

'use strict';

// atris nexus review, one by one. Every backend call is a stand-in, the terminal is a
// stand-in, and the saved place goes to a throwaway folder. Not run against a live backend.
// Only made-up people appear here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const { nexusCommand } = require('../commands/nexus');
const store = require('../commands/nexus-store');
const R = require('../commands/nexus-review');

const NOW = new Date(2026, 10, 16, 12); // a Monday
const RAE = '11111111-1111-4111-8111-111111111111';
const BO = '22222222-2222-4222-8222-222222222222';
const CY = '33333333-3333-4333-8333-333333333333';
const DI = '44444444-4444-4444-8444-444444444444';

function mineCard(id, name, over = {}, priv = {}) {
  return {
    id, is_public: false, mine: true, name, title: null, company_name: null, location_raw: null, place: null,
    private: { stage: 'found', closeness: 1, note: null, next_move: null, due_on: null, paid_cents: 0, paid_checked: false, last_touch_at: null, via_person_id: null, group_name: null, ...priv },
    ...over,
  };
}

const LONG_NOTE = `${'Met at the school fair and talked about the spring workshop. '.repeat(6)}END-OF-NOTE`;

function seed() {
  const touches = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `t${n}`, person_id: CY, kind: 'note', body: `touch number ${n}`, at: `2026-11-0${n}T09:00:00+00:00` }));
  return {
    people: [
      mineCard(RAE, 'Rae Sample', { title: 'Founder', company_name: 'Sample Co' }, { stage: 'replied', note: 'Likes email', due_on: '2026-11-12', group_name: 'Fremont' }),
      mineCard(BO, 'Bo Example', { company_name: 'Example Inc' }, { stage: 'found', group_name: 'Fremont' }),
      mineCard(CY, 'Cy Placeholder', { company_name: 'Placeholder Ltd' }, { stage: 'met', note: LONG_NOTE, due_on: '2026-11-16' }),
      mineCard(DI, 'Di Four', {}, { stage: 'found', due_on: '2026-11-30' }),
    ],
    ties: {},
    touches: { [CY]: touches.reverse() },
  };
}

// A stand-in for the store: search with its filters, one card, the three writes.
function backend({ data = seed(), down = null, fail = {} } = {}) {
  const state = { calls: [], data };
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, data: body, error: body && body.detail });
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const url = new URL(pathname, 'https://x.test');
    const method = options.method || 'GET';
    state.calls.push({ method, path: url.pathname, body: options.body });
    if (down === 0) return { ok: false, status: 0, data: null, error: 'ECONNREFUSED' };
    const key = `${method} ${url.pathname}`;
    const d = state.data;
    let m;
    const failing = Object.keys(fail).find((pattern) => new RegExp(`^${pattern}$`).test(key));
    if (failing) return answer(fail[failing], { detail: 'failed' });
    if (key === 'POST /nexus/people/search') {
      const { q, stage, group, limit = 50, offset = 0 } = options.body;
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = d.people.filter((c) => words.every((w) => `${c.name} ${c.company_name || ''}`.toLowerCase().includes(w))
        && (!stage || c.private.stage === stage) && (!group || c.private.group_name === group));
      return answer(200, { total: hits.length, people: hits.slice(offset, offset + limit), from_businesses: [] });
    }
    if ((m = /^GET \/nexus\/people\/([^/]+)$/.exec(key))) {
      const card = d.people.find((c) => c.id === m[1]);
      return card ? answer(200, { card, ties: d.ties[m[1]] || [], touches: d.touches[m[1]] || [] }) : answer(404, { detail: 'Not found' });
    }
    if ((m = /^PATCH \/nexus\/people\/([^/]+)\/mine$/.exec(key))) {
      const card = d.people.find((c) => c.id === m[1]);
      card.private = { ...card.private, ...options.body };
      return answer(200, { card });
    }
    if (key === 'POST /nexus/touches') {
      const touch = { id: `new${state.calls.length}`, person_id: options.body.person_id, kind: options.body.kind, body: options.body.body, at: '2026-11-16T12:00:00+00:00' };
      (d.touches[touch.person_id] = d.touches[touch.person_id] || []).unshift(touch);
      return answer(200, { touch });
    }
    throw new Error(`unexpected call ${key}`);
  };
  return { state, request };
}

// A terminal: keys go in as bytes, the screen comes out as text.
function terminal({ tty = true } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  stdin.raw = [];
  stdin.setRawMode = (on) => { stdin.raw.push(on); };
  const stdout = { isTTY: tty, text: '', writes: 0, write(chunk) { this.writes += 1; this.text += chunk; return true; } };
  return { stdin, stdout };
}

async function until(check, what = 'the screen') {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for ${what}`);
}

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = options.server || backend(options);
  const out = [];
  const errs = [];
  const go = (args, extra = {}) => {
    const term = extra.term || terminal();
    const done = nexusCommand(args, {
      log: (line) => out.push(String(line)),
      err: (line) => errs.push(String(line)),
      getToken: async () => ({ token: 'tok' }),
      apiRequestJson: server.request,
      now: () => NOW,
      nexusDir: dir,
      stdin: term.stdin,
      stdout: term.stdout,
      ...extra.deps,
    });
    return { done, term };
  };
  return { dir, server, out, errs, go };
}

const writes = (server) => server.state.calls.filter((c) => c.method !== 'GET' && c.path !== '/nexus/people/search');
const typeLine = (term, text) => term.stdin.write(`${text}\r`);

// ---- the filter ----

test('review arguments: the filter words, and what is refused', () => {
  assert.deepEqual(R.parseReviewArgs(['review']).opts, { due: false, restart: false });
  assert.deepEqual(R.parseReviewArgs(['review', '--stage', 'met', '--list', 'Fremont', '--search', 'ann lee', '--due', '--restart', '--json']).opts, { due: true, restart: true, stage: 'met', list: 'Fremont', search: 'ann lee' });
  assert.deepEqual(R.parseReviewArgs(['--json', 'review', '--stage=replied', '--group=Fremont']).opts, { due: false, restart: false, stage: 'replied', list: 'Fremont' });
  assert.match(R.parseReviewArgs(['review', '--stage']).error, /--stage needs a value/);
  assert.match(R.parseReviewArgs(['review', '--search', '  ']).error, /--search needs a value/);
  const stray = R.parseReviewArgs(['review', 'rae']).error;
  assert.match(stray, /does not take a name or a word on its own/);
  assert.ok(!stray.includes('rae'), 'what was typed is not echoed back');
  assert.match(R.parseReviewArgs(['review', '--weird']).error, /does not know --weird/);
});

test('review filter: stage words are the store\'s, the list is the group, search words are tidied', () => {
  assert.deepEqual(R.buildFilter({ due: false }).filter, { due: false });
  assert.deepEqual(R.buildFilter({ stage: 'reached', list: ' Fremont ', search: '  Ann   Lee ', due: true }).filter, { due: true, stage: 'reached_out', group: 'Fremont', q: 'Ann Lee' });
  assert.equal(R.buildFilter({ stage: 'met' }).filter.stage, 'met');
  assert.match(R.buildFilter({ stage: 'nope' }).error, /"nope" is not a stage\. Use found, reached, replied, met, paying or partner\./);
  assert.equal(R.describeFilter({ stage: 'met', group: 'Fremont', q: 'ann', due: true }), 'met, in "Fremont", matching "ann", follow-up due');
});

test('review filter key: same filter, same key, and no words in it', () => {
  const a = R.filterKey({ stage: 'met', group: 'Fremont', q: 'Fremont Schools', due: false });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, R.filterKey({ stage: 'met', group: 'Fremont', q: 'fremont schools', due: false }), 'search words ignore case');
  assert.notEqual(a, R.filterKey({ stage: 'met', group: 'Fremont', due: false }));
  assert.notEqual(a, R.filterKey({ stage: 'found', group: 'Fremont', q: 'fremont schools', due: false }));
  assert.notEqual(R.filterKey({ due: true }), R.filterKey({ due: false }));
  assert.ok(!/fremont|met/i.test(a));
});

test('review --due keeps people whose follow-up day has come, longest overdue first', () => {
  const cards = seed().people;
  const due = R.dueOnly(cards, '2026-11-16');
  assert.deepEqual(due.map((c) => c.name), ['Rae Sample', 'Cy Placeholder']);
  assert.deepEqual(R.dueOnly(cards, '2026-11-11'), []);
});

// ---- date words ----

test('follow-up date words, counted from a Monday', () => {
  const day = (word) => R.followUpDay(word, NOW);
  assert.deepEqual(day('2026-12-01'), { ok: true, day: '2026-12-01' });
  assert.deepEqual(day('today'), { ok: true, day: '2026-11-16' });
  assert.deepEqual(day('tomorrow'), { ok: true, day: '2026-11-17' });
  assert.deepEqual(day('clear'), { ok: true, day: null });
  assert.deepEqual(day('fri'), { ok: true, day: '2026-11-20' });
  assert.deepEqual(day('Friday'), { ok: true, day: '2026-11-20' });
  assert.deepEqual(day('next fri'), { ok: true, day: '2026-11-20' });
  assert.deepEqual(day('mon'), { ok: true, day: '2026-11-23' }, 'the same weekday means next week, never today');
  assert.deepEqual(day('sun'), { ok: true, day: '2026-11-22' });
  assert.deepEqual(day('+3'), { ok: true, day: '2026-11-19' });
  assert.deepEqual(day('+0'), { ok: true, day: '2026-11-16' });
  assert.deepEqual(day('+3d'), { ok: true, day: '2026-11-19' });
  assert.deepEqual(day('+2w'), { ok: true, day: '2026-11-30' });
  assert.deepEqual(day('+20'), { ok: true, day: '2026-12-06' }, 'crosses the month');
  for (const bad of ['', 'soon', '2026-02-30', '+', '+x', '-3', '+99999', 'fridayish']) assert.equal(day(bad).ok, false, bad);
  // From a Friday, "fri" is a week away; from a Saturday, "mon" is two days away.
  assert.equal(R.followUpDay('fri', new Date(2026, 10, 20)).day, '2026-11-27');
  assert.equal(R.followUpDay('mon', new Date(2026, 10, 21)).day, '2026-11-23');
});

test('the follow-up line is a day word and then an optional next move', () => {
  assert.deepEqual(R.parseDueLine('fri', NOW), { ok: true, day: '2026-11-20', move: '' });
  assert.deepEqual(R.parseDueLine('  +3  send the proposal ', NOW), { ok: true, day: '2026-11-19', move: 'send the proposal' });
  assert.deepEqual(R.parseDueLine('next fri call about the fair', NOW), { ok: true, day: '2026-11-20', move: 'call about the fair' });
  assert.deepEqual(R.parseDueLine('clear', NOW), { ok: true, day: null, move: '' });
  assert.equal(R.parseDueLine('call about the fair', NOW).ok, false);
  assert.equal(R.parseDueLine('   ', NOW).ok, false);
});

// ---- the saved place ----

test('saved place: set, replace, take off, cap, and junk is no place', () => {
  const k1 = 'aaaaaaaaaaaaaaaa';
  const k2 = 'bbbbbbbbbbbbbbbb';
  let entries = R.withPosition([], k1, RAE);
  entries = R.withPosition(entries, k2, BO);
  assert.equal(R.positionFor(entries, k1), RAE);
  assert.equal(R.positionFor(entries, 'cccccccccccccccc'), null);
  entries = R.withPosition(entries, k1, CY);
  assert.deepEqual(entries, [{ key: k2, id: BO }, { key: k1, id: CY }], 'the newest goes last');
  assert.deepEqual(R.withPosition(entries, k1, null), [{ key: k2, id: BO }]);
  let many = [];
  for (let i = 0; i < 60; i++) many = R.withPosition(many, String(i).padStart(16, 'a'), RAE);
  assert.equal(many.length, 50);
  assert.deepEqual(R.parsePositions('not json'), []);
  assert.deepEqual(R.parsePositions('{"places":[{"key":"zz","id":"x"},{"key":"aaaaaaaaaaaaaaaa","id":"11111111-1111-4111-8111-111111111111"},{"key":"bbbbbbbbbbbbbbbb","id":"Rae Sample"}]}'), [{ key: k1, id: RAE }]);
});

test('saved place file holds a fingerprint and a person id, in a private file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(R.readPositions(dir), [], 'no file is no places');
  R.writePositions(dir, R.withPosition([], R.filterKey({ stage: 'met', q: 'fremont schools', due: false }), RAE));
  const file = R.positionsFile(dir);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'places']);
  assert.ok(!/fremont|schools|rae|sample|met/i.test(text.replace(RAE, '')), 'no words from the filter and no names');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['review.json'], 'no side file is left behind');
  assert.equal(R.positionFor(R.readPositions(dir), R.filterKey({ stage: 'met', q: 'fremont schools', due: false })), RAE);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(R.readPositions(dir), [], 'a damaged file is no places, not a crash');
});

test('the place to save skips people a change took off the filter', () => {
  const found = (id, stage, due_on = null) => mineCard(id, id, {}, { stage, due_on });
  const people = [found('a', 'found'), found('b', 'found'), found('c', 'found')];
  const filter = { stage: 'found', due: false };
  assert.equal(R.positionToSave(people, 1, filter, '2026-11-16'), 'b');
  people[1].private.stage = 'met';
  assert.equal(R.positionToSave(people, 1, filter, '2026-11-16'), 'c', 'b moved on, so the next one who still fits');
  people[2].private.stage = 'met';
  assert.equal(R.positionToSave(people, 1, filter, '2026-11-16'), null, 'no one left to come back to');
  const due = [found('a', 'found', '2026-11-10'), found('b', 'found', '2026-11-12')];
  assert.equal(R.positionToSave(due, 0, { due: true }, '2026-11-16'), 'a');
  due[0].private.due_on = '2026-11-20';
  assert.equal(R.positionToSave(due, 0, { due: true }, '2026-11-16'), 'b', 'a follow-up set for later leaves the due list');
  assert.equal(R.positionToSave([], 0, filter, '2026-11-16'), null);
});

// ---- loading ----

test('loading pages through the store\'s search with the filter in the body', async () => {
  const many = Array.from({ length: 450 }, (_, i) => mineCard(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Person ${i}`));
  const server = backend({ data: { people: many, ties: {}, touches: {} } });
  const client = store.storeClient(server.request, 'tok');
  const loaded = await R.loadPeople(client, { stage: 'found', group: undefined, q: 'person', due: false }, '2026-11-16');
  assert.equal(loaded.people.length, 450);
  assert.equal(loaded.total, 450);
  assert.deepEqual(server.state.calls.map((c) => [c.path, c.body.offset, c.body.limit, c.body.stage, c.body.q]), [
    ['/nexus/people/search', 0, 200, 'found', 'person'],
    ['/nexus/people/search', 200, 200, 'found', 'person'],
    ['/nexus/people/search', 400, 200, 'found', 'person'],
  ]);
  const empty = await R.loadPeople(store.storeClient(backend({ data: { people: [], ties: {}, touches: {} } }).request, 'tok'), { due: false }, '2026-11-16');
  assert.deepEqual(empty, { people: [], total: 0, truncated: false });
});

// ---- the key handler, driven with fake key events ----

function fakeActions(log, opts = {}) {
  return {
    async show(card, { full } = {}) {
      log.push(['show', card.id, !!full]);
      if (opts.showFails && opts.showFails(card)) throw new Error('The people store did not answer.');
      return { lines: [`card for ${card.id}`, full ? 'FULL' : 'plain'], card };
    },
    async stage(card, stage) { log.push(['stage', card.id, stage]); if (opts.fail) throw new Error(opts.fail); return { message: `staged ${stage}` }; },
    async note(card, text) { log.push(['note', card.id, text]); if (opts.fail) throw new Error(opts.fail); return { message: `noted ${text}` }; },
    async due(card, day, move) { log.push(['due', card.id, day, move]); if (opts.fail) throw new Error(opts.fail); return { message: `due ${day}` }; },
  };
}

function walkOf(extra = {}) {
  const log = [];
  const out = [];
  const people = extra.people || seed().people;
  const walk = R.createWalk({ people, filter: { due: false }, actions: fakeActions(log, extra), out: (text) => out.push(text), clock: () => NOW, ...extra.walk });
  return { walk, log, out, people, screen: () => out.join('') };
}

const press = async (walk, ...keys) => { for (const k of keys) await walk.key(...(Array.isArray(k) ? k : [k, { name: k }])); };

test('keys: n and right go on, p and left go back, and the ends say so', async () => {
  const { walk, log, out } = walkOf();
  await walk.start();
  assert.match(out.join(''), /1 of 4/);
  await press(walk, 'n');
  assert.equal(walk.state.at, 1);
  await press(walk, [undefined, { name: 'right' }]);
  assert.equal(walk.state.at, 2);
  await press(walk, 'p');
  assert.equal(walk.state.at, 1);
  await press(walk, [undefined, { name: 'left' }]);
  assert.equal(walk.state.at, 0);
  await press(walk, 'p');
  assert.equal(walk.state.at, 0);
  assert.match(out[out.length - 1], /That is the first one\./);
  await press(walk, 'n', 'n', 'n', 'n');
  assert.equal(walk.state.at, 3);
  assert.match(out[out.length - 1], /That is the last one\./);
  assert.match(out[out.length - 1], /4 of 4/);
  assert.equal(log.every(([what]) => what === 'show'), true, 'moving around writes nothing');
});

test('keys: s then a number sets that stage, with the right store function', async () => {
  const { walk, log, out } = walkOf();
  await walk.start();
  await press(walk, 's');
  assert.equal(walk.state.mode, 'stage');
  assert.match(out.join(''), /1 Found {3}2 Reached out {3}3 Replied {3}4 Met {3}5 Paying {3}6 Partner/);
  await press(walk, '9', 'x');
  assert.equal(walk.state.mode, 'stage', 'a number that is not a stage waits');
  await press(walk, '4');
  assert.deepEqual(log.filter(([what]) => what === 'stage'), [['stage', RAE, 'met']]);
  assert.equal(walk.state.mode, 'browse');
  assert.match(out[out.length - 1], /staged met/);
  assert.equal(log.at(-1)[0], 'show', 'the card is drawn again after a change');
  await press(walk, 's', [undefined, { name: 'escape' }]);
  assert.equal(walk.state.mode, 'browse');
  assert.equal(log.filter(([what]) => what === 'stage').length, 1, 'Esc changes nothing');
  await press(walk, 'n', 's', '1');
  assert.deepEqual(log.filter(([what]) => what === 'stage').length, 1, 'Found on a card already Found is not a change');
  assert.match(out[out.length - 1], /Already Found\./);
});

test('keys: t then a line adds that note, Enter sends it, Esc and empty do not', async () => {
  const { walk, log, out } = walkOf();
  await walk.start();
  await press(walk, 't');
  for (const ch of 'called bak') await press(walk, ch);
  await press(walk, [undefined, { name: 'backspace' }], 'c', 'k');
  assert.match(out.join(''), /Note: called back/);
  await press(walk, [undefined, { name: 'return' }]);
  assert.deepEqual(log.filter(([what]) => what === 'note'), [['note', RAE, 'called back']]);
  assert.match(out[out.length - 1], /noted called back/);
  await press(walk, 't', 'x', [undefined, { name: 'escape' }]);
  await press(walk, 't', ' ', [undefined, { name: 'return' }]);
  assert.equal(log.filter(([what]) => what === 'note').length, 1);
  assert.match(out[out.length - 1], /Nothing to add\./);
  await press(walk, 't', 'q', 'n', 's');
  assert.equal(walk.state.done, false, 'letters typed into a note are not commands');
  assert.equal(walk.state.buffer, 'qns');
});

test('keys: d then a day sets the follow-up, and says so when it cannot read the day', async () => {
  const { walk, log, out } = walkOf();
  await walk.start();
  const type = async (text) => { for (const ch of text) await press(walk, ch); await press(walk, [undefined, { name: 'return' }]); };
  await press(walk, 'd');
  await type('fri');
  assert.deepEqual(log.filter(([what]) => what === 'due'), [['due', RAE, '2026-11-20', '']]);
  await press(walk, 'd');
  await type('+3 send the proposal');
  assert.deepEqual(log.filter(([what]) => what === 'due').at(-1), ['due', RAE, '2026-11-19', 'send the proposal']);
  await press(walk, 'd');
  await type('2026-12-01');
  assert.deepEqual(log.filter(([what]) => what === 'due').at(-1), ['due', RAE, '2026-12-01', '']);
  await press(walk, 'd');
  await type('clear');
  assert.deepEqual(log.filter(([what]) => what === 'due').at(-1), ['due', RAE, null, '']);
  const before = log.filter(([what]) => what === 'due').length;
  await press(walk, 'd');
  await type('someday');
  assert.equal(log.filter(([what]) => what === 'due').length, before, 'nothing is sent for a day that cannot be read');
  assert.match(out[out.length - 1], /"someday" is not a day\. Use YYYY-MM-DD, today, tomorrow, a weekday like fri, \+3/);
  assert.equal(walk.state.mode, 'browse');
});

test('keys: o draws the full card, q and Ctrl-C leave, anything else is ignored', async () => {
  const { walk, log } = walkOf();
  await walk.start();
  await press(walk, 'o');
  assert.deepEqual(log.at(-1), ['show', RAE, true]);
  await press(walk, 'z', '5', [undefined, { name: 'up' }], ['\x0e', { name: 'n', ctrl: true }]);
  assert.equal(walk.state.at, 0, 'unknown keys and Ctrl-N do nothing');
  assert.equal(walk.state.done, false);
  await press(walk, 'q');
  assert.equal(walk.state.done, true);
  await walk.finished;
  const second = walkOf();
  await second.walk.start();
  await press(second.walk, 'n', ['\x03', { name: 'c', ctrl: true }]);
  assert.equal(second.walk.state.done, true);
  await press(second.walk, 'n');
  assert.equal(second.walk.state.at, 1, 'once finished, keys do nothing');
});

test('Ctrl-C leaves from inside a prompt too', async () => {
  const { walk } = walkOf();
  await walk.start();
  await press(walk, 't', 'h', ['\x03', { name: 'c', ctrl: true }]);
  assert.equal(walk.state.done, true);
});

test('a call that fails shows its plain sentence and the walk goes on', async () => {
  const { walk, out } = walkOf({ fail: 'That did not save. Try again in a moment.' });
  await walk.start();
  await press(walk, 's', '4');
  assert.match(out[out.length - 1], /That did not save\. Try again in a moment\./);
  assert.equal(walk.state.done, false);
  await press(walk, 'n');
  assert.equal(walk.state.at, 1);
  const shaky = walkOf({ showFails: (card) => card.id === BO });
  await shaky.walk.start();
  await press(shaky.walk, 'n');
  assert.match(shaky.screen(), /That card did not load\./);
  assert.match(shaky.screen(), /2 of 4/);
  await press(shaky.walk, 'n');
  assert.equal(shaky.walk.state.at, 2);
});

test('keys pressed while a call is out wait their turn, in order', async () => {
  const log = [];
  let release;
  const actions = fakeActions(log);
  actions.stage = (card, stage) => new Promise((resolve) => { release = () => { log.push(['stage', card.id, stage]); resolve({ message: 'ok' }); }; });
  const walk = R.createWalk({ people: seed().people, filter: { due: false }, actions, out: () => {}, clock: () => NOW });
  await walk.start();
  await press(walk, 's');
  const pending = [walk.key('4', { name: '4' }), walk.key('n', { name: 'n' })];
  await until(() => typeof release === 'function', 'the stage call');
  assert.equal(walk.state.at, 0, 'n has not run yet');
  release();
  await Promise.all(pending);
  assert.equal(walk.state.at, 1);
  assert.deepEqual(log.filter(([what]) => what === 'stage'), [['stage', RAE, 'met']]);
});

// ---- the real actions: one way to write ----

test('each action runs the store\'s own code for stage, note and due', async (t) => {
  const seen = [];
  t.mock.method(store, 'runStore', async (ctx) => { seen.push(ctx); });
  const actions = R.makeActions({ request: async () => { throw new Error('no call expected'); }, token: 'tok', view: { marker: 1 }, clock: () => NOW });
  const card = seed().people[0];
  await actions.stage(card, 'met');
  await actions.note(card, 'hello there');
  await actions.due(card, '2026-11-20', 'call back');
  await actions.due(card, null);
  await actions.show(card);
  await actions.show(card, { full: true });
  assert.deepEqual(seen.map((c) => [c.sub, c.words.slice(0, 1)[0] === 'stage' || c.words[0] === 'note' || c.words[0] === 'due' ? c.words[0] : 'show']), [
    ['stage', 'stage'], ['note', 'note'], ['due', 'due'], ['due', 'due'], [undefined, 'show'], [undefined, 'show'],
  ]);
  assert.deepEqual(seen[0].words, ['stage', 'Rae Sample', 'met']);
  assert.deepEqual(seen[1].words, ['note', 'Rae Sample', 'hello there']);
  assert.deepEqual(seen[2].prep.args, { day: '2026-11-20', move: 'call back' });
  assert.deepEqual(seen[3].prep.args, { day: null, move: '' });
  assert.equal(seen[4].view.marker, 1);
  assert.equal(typeof seen[5].view.card, 'function');
});

test('a change goes out exactly as stage, note and due send it', async () => {
  const sent = async (run) => {
    const server = backend();
    await run(server);
    return writes(server).map((c) => [c.method, c.path, c.body]);
  };
  const viaCommand = async (args) => sent((server) => nexusCommand(args, { log() {}, err() {}, getToken: async () => ({ token: 'tok' }), apiRequestJson: server.request, now: () => NOW, tz: 'UTC' }));
  const viaReview = async (run) => sent(async (server) => {
    const actions = R.makeActions({ request: server.request, token: 'tok', view: {}, clock: () => NOW });
    await run(actions, server.state.data.people[0]);
  });

  assert.deepEqual(await viaReview((a, card) => a.stage(card, 'met')), await viaCommand(['stage', 'Rae Sample', 'met']));
  assert.deepEqual(await viaReview((a, card) => a.note(card, 'hello there')), await viaCommand(['note', 'Rae Sample', 'hello there']));
  assert.deepEqual(await viaReview((a, card) => a.due(card, '2026-11-20', 'call back')), await viaCommand(['due', 'Rae Sample', '2026-11-20', 'call back']));
  assert.deepEqual(await viaReview((a, card) => a.due(card, null)), await viaCommand(['due', 'Rae Sample', 'clear']));
  // And the shape of it, so a change to either side shows up here.
  assert.deepEqual(await viaReview((a, card) => a.stage(card, 'met')), [['PATCH', `/nexus/people/${RAE}/mine`, { stage: 'met' }]]);
  assert.deepEqual((await viaReview((a, card) => a.note(card, 'hello there'))).map(([m, p]) => `${m} ${p}`), ['POST /nexus/touches', `PATCH /nexus/people/${RAE}/mine`]);
});

test('a note on a person whose name is shared with another goes to the person on screen', async () => {
  const data = seed();
  data.people.push(mineCard('55555555-5555-4555-8555-555555555555', 'Rae Sample', {}, { stage: 'found' }));
  const server = backend({ data });
  const actions = R.makeActions({ request: server.request, token: 'tok', view: {}, clock: () => NOW });
  await actions.note(data.people[4], 'the other Rae');
  assert.deepEqual(writes(server).map((c) => c.body.person_id || c.path), ['55555555-5555-4555-8555-555555555555', '/nexus/people/55555555-5555-4555-8555-555555555555/mine']);
});

// ---- the whole command, on a stand-in terminal ----

test('a walk: cards one at a time with the counter, and the same lines as showing one card by name', async (t) => {
  const { go, out, server } = setup(t);
  const plain = [];
  await nexusCommand(['Cy Placeholder'], { log: (l) => plain.push(l), err() {}, getToken: async () => ({ token: 'tok' }), apiRequestJson: server.request, now: () => NOW, tz: 'UTC' });
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  assert.match(term.stdout.text, /Rae Sample/);
  term.stdin.write('n');
  await until(() => term.stdout.text.includes('2 of 4'));
  term.stdin.write('n');
  await until(() => term.stdout.text.includes('3 of 4'));
  const third = term.stdout.text.slice(term.stdout.text.lastIndexOf('3 of 4'));
  for (const line of plain) assert.ok(third.includes(line), `the card shows "${line}"`);
  assert.ok(third.includes('touch number 6') && third.includes('touch number 3'), 'the plain card shows four touches');
  assert.ok(!third.includes('touch number 2') && !third.includes('touch number 1'), 'and no more');
  term.stdin.write('o');
  await until(() => term.stdout.text.lastIndexOf('touch number 1') > term.stdout.text.lastIndexOf('3 of 4'));
  const full = term.stdout.text.slice(term.stdout.text.lastIndexOf('3 of 4'));
  for (let n = 1; n <= 6; n++) assert.ok(full.includes(`touch number ${n}`), `o shows touch ${n}`);
  assert.ok(full.includes('END-OF-NOTE'), 'o shows the whole note');
  assert.ok(!third.includes('END-OF-NOTE'), 'the plain card cuts a long note');
  term.stdin.write('q');
  assert.equal(await done, 0);
  assert.match(out.join('\n'), /Stopped at 3 of 4\./);
});

test('a walk restores the terminal on quit and keeps one place for the filter', async (t) => {
  const { go, out, dir } = setup(t);
  const first = go(['review', '--stage', 'found']);
  await until(() => first.term.stdout.text.includes('1 of 2'));
  assert.match(first.term.stdout.text, /\(found\)/);
  first.term.stdin.write('n');
  await until(() => first.term.stdout.text.includes('2 of 2'));
  first.term.stdin.write('q');
  assert.equal(await first.done, 0);
  assert.deepEqual(first.term.stdin.raw, [true, false], 'raw mode on, then off');
  assert.ok(first.term.stdout.text.endsWith('\x1b[?25h'), 'the cursor is shown again');
  assert.ok(first.term.stdout.text.includes('\x1b[?25l'), 'and was hidden while walking');
  const saved = fs.readFileSync(path.join(dir, 'review.json'), 'utf8');
  assert.ok(saved.includes(DI), 'the person id is kept');
  assert.ok(!/Di Four|Bo|Example|Rae|Sample|found|Fremont/.test(saved), 'no name, company, stage or list word is kept');
  assert.equal(out.length, 1);

  const again = go(['review', '--stage', 'found']);
  await until(() => again.term.stdout.text.includes('of 2'));
  assert.match(again.term.stdout.text, /2 of 2/);
  assert.match(again.term.stdout.text, /Picking up where you stopped\. Add --restart to begin again\./);
  again.term.stdin.write('q');
  await again.done;

  const restart = go(['review', '--stage', 'found', '--restart']);
  await until(() => restart.term.stdout.text.includes('of 2'));
  assert.match(restart.term.stdout.text, /1 of 2/);
  assert.doesNotMatch(restart.term.stdout.text, /Picking up/);
  restart.term.stdin.write('q');
  await restart.done;

  const other = go(['review']);
  await until(() => other.term.stdout.text.includes('of 4'));
  assert.match(other.term.stdout.text, /1 of 4/, 'a different filter has its own place');
  other.term.stdin.write('q');
  await other.done;
});

test('after a change under --stage, the place saved is the next person who still fits', async (t) => {
  const { go, dir } = setup(t);
  const { done, term } = go(['review', '--stage', 'found']);
  await until(() => term.stdout.text.includes('1 of 2'));
  term.stdin.write('s');
  term.stdin.write('3');
  await until(() => /is now Replied/.test(term.stdout.text));
  term.stdin.write('q');
  await done;
  assert.ok(fs.readFileSync(path.join(dir, 'review.json'), 'utf8').includes(DI), 'Bo moved on, so the place is Di, the next who still fits');
  const resumed = go(['review', '--stage', 'found']);
  await until(() => resumed.term.stdout.text.includes('of '));
  assert.match(resumed.term.stdout.text, /1 of 1/);
  assert.match(resumed.term.stdout.text, /Di Four/);
  resumed.term.stdin.write('q');
  await resumed.done;
});

test('Ctrl-C leaves cleanly and keeps the place', async (t) => {
  const { go, dir } = setup(t);
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  term.stdin.write('n');
  await until(() => term.stdout.text.includes('2 of 4'));
  term.stdin.write('\x03');
  assert.equal(await done, 0);
  assert.deepEqual(term.stdin.raw, [true, false]);
  assert.ok(term.stdout.text.endsWith('\x1b[?25h'));
  assert.ok(fs.readFileSync(path.join(dir, 'review.json'), 'utf8').includes(BO));
});

test('every key on a stand-in terminal reaches the store: stage, note, follow-up', async (t) => {
  const { go, server } = setup(t);
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  term.stdin.write('s');
  term.stdin.write('4');
  await until(() => /Rae Sample is now Met \(was Replied\)\./.test(term.stdout.text));
  term.stdin.write('t');
  typeLine(term, 'asked about spring');
  await until(() => /Noted on Rae Sample: asked about spring/.test(term.stdout.text));
  term.stdin.write('d');
  typeLine(term, 'fri send the plan');
  await until(() => /Follow-up for Rae Sample set for Nov 20\. Next move: send the plan/.test(term.stdout.text));
  term.stdin.write('q');
  await done;
  assert.deepEqual(writes(server).map((c) => [c.method, c.path, c.body]), [
    ['PATCH', `/nexus/people/${RAE}/mine`, { stage: 'met' }],
    ['POST', '/nexus/touches', { person_id: RAE, kind: 'note', body: 'asked about spring' }],
    ['PATCH', `/nexus/people/${RAE}/mine`, { note: 'Likes email | asked about spring' }],
    ['PATCH', `/nexus/people/${RAE}/mine`, { due_on: '2026-11-20', next_move: 'send the plan' }],
  ]);
  const card = server.state.data.people[0].private;
  assert.equal(card.stage, 'met');
  assert.equal(card.due_on, '2026-11-20');
});

test('a second note adds to the first, because the card is read again after each change', async (t) => {
  const { go, server } = setup(t);
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  term.stdin.write('t');
  typeLine(term, 'one');
  await until(() => /Noted on Rae Sample: one/.test(term.stdout.text));
  term.stdin.write('t');
  typeLine(term, 'two');
  await until(() => /Noted on Rae Sample: two/.test(term.stdout.text));
  term.stdin.write('q');
  await done;
  assert.equal(server.state.data.people[0].private.note, 'Likes email | one | two');
});

test('a change the store refuses shows a plain sentence and the walk keeps going', async (t) => {
  const { go } = setup(t, { fail: { 'PATCH /nexus/people/[^/]+/mine': 500 } });
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  term.stdin.write('s');
  term.stdin.write('4');
  await until(() => /That did not save\. Try again in a moment\./.test(term.stdout.text));
  term.stdin.write('n');
  await until(() => term.stdout.text.includes('2 of 4'));
  term.stdin.write('q');
  assert.equal(await done, 0);
});

test('an error while walking still gives the terminal back', async (t) => {
  const term = terminal();
  let first = true;
  const write = term.stdout.write.bind(term.stdout);
  term.stdout.write = (chunk) => {
    if (first && chunk.includes('1 of 4')) { first = false; throw new Error('EPIPE'); }
    return write(chunk);
  };
  const { go, errs } = setup(t);
  const { done } = go(['review'], { term });
  assert.equal(await done, 1);
  assert.deepEqual(term.stdin.raw, [true, false]);
  assert.ok(term.stdout.text.endsWith('\x1b[?25h'));
  assert.match(errs.join('\n'), /EPIPE/);
});

test('no process listeners are left behind after a walk', async (t) => {
  const kinds = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'];
  const before = kinds.map((k) => process.listenerCount(k));
  const { go } = setup(t);
  const { done, term } = go(['review']);
  await until(() => term.stdout.text.includes('1 of 4'));
  assert.deepEqual(kinds.map((k) => process.listenerCount(k)), before.map((n) => n + 1), 'one of each while walking');
  assert.equal(term.stdin.listenerCount('keypress'), 1);
  term.stdin.write('q');
  await done;
  assert.deepEqual(kinds.map((k) => process.listenerCount(k)), before);
  assert.equal(term.stdin.listenerCount('keypress'), 0);
});

test('the filters reach the store\'s search', async (t) => {
  const { go, server } = setup(t);
  const { done, term } = go(['review', '--stage', 'reached', '--list', 'Fremont', '--search', 'rae  sample']);
  await until(() => /No one on your list fits/.test(term.stdout.text) || server.state.calls.length > 0);
  await done;
  assert.deepEqual(server.state.calls.map((c) => c.body), [{ limit: 200, offset: 0, q: 'rae sample', group: 'Fremont', stage: 'reached_out' }]);
});

test('--due walks only the people whose follow-up has come, longest overdue first', async (t) => {
  const { go } = setup(t);
  const { done, term } = go(['review', '--due']);
  await until(() => term.stdout.text.includes('1 of 2'));
  assert.match(term.stdout.text, /\(follow-up due\)/);
  assert.match(term.stdout.text, /Rae Sample/);
  term.stdin.write('n');
  await until(() => term.stdout.text.includes('2 of 2'));
  assert.ok(term.stdout.text.slice(term.stdout.text.lastIndexOf('2 of 2')).includes('Cy Placeholder'));
  term.stdin.write('q');
  await done;
});

test('nobody fits: say so and leave without touching the terminal', async (t) => {
  const { go, out } = setup(t);
  const { done, term } = go(['review', '--stage', 'partner']);
  assert.equal(await done, 0);
  assert.deepEqual(term.stdin.raw, []);
  assert.match(out.join('\n'), /No one on your list fits \(partner\)\./);
});

// ---- when there is no terminal ----

test('off a terminal it prints the matching people as one JSON object and never waits for keys', async (t) => {
  const { go, out, dir } = setup(t);
  const term = terminal({ tty: false });
  let listened = false;
  term.stdin.on('newListener', () => { listened = true; });
  const { done } = go(['review', '--stage', 'found'], { term });
  assert.equal(await done, 0);
  assert.equal(out.length, 1, 'one line of output');
  const body = JSON.parse(out[0]);
  assert.equal(body.ok, true);
  assert.equal(body.total, 2);
  assert.deepEqual(body.people.map((p) => p.name), ['Bo Example', 'Di Four']);
  assert.equal(term.stdout.writes, 0, 'nothing is drawn');
  assert.deepEqual(term.stdin.raw, [], 'raw mode is never switched on');
  assert.equal(listened, false, 'no one listens for keys');
  assert.equal(fs.existsSync(path.join(dir, 'review.json')), false, 'no place is saved');
});

test('--json prints the same object even on a terminal, and so does a terminal that only has output', async (t) => {
  const { go, out } = setup(t);
  const tty = go(['review', '--json']);
  assert.equal(await tty.done, 0);
  assert.equal(JSON.parse(out[0]).total, 4);
  assert.deepEqual(tty.term.stdin.raw, []);
  const half = terminal();
  half.stdin.isTTY = false;
  const piped = go(['review'], { term: half });
  assert.equal(await piped.done, 0);
  assert.equal(JSON.parse(out[1]).total, 4);
  const due = go(['review', '--due', '--json']);
  await due.done;
  assert.deepEqual(JSON.parse(out[2]).people.map((p) => p.name), ['Rae Sample', 'Cy Placeholder']);
});

test('--json with nobody matching is an empty list, not an error', async (t) => {
  const { go, out } = setup(t);
  assert.equal(await go(['review', '--stage', 'partner', '--json']).done, 0);
  assert.deepEqual(JSON.parse(out[0]), { ok: true, total: 0, people: [] });
});

// ---- trouble before the walk starts ----

test('when the store does not answer, review stops with a plain sentence and never touches the terminal', async (t) => {
  const { go, errs, out } = setup(t, { down: 0 });
  const { done, term } = go(['review']);
  assert.equal(await done, 1);
  assert.match(errs.join('\n'), /The people store did not answer, and review needs it\./);
  assert.deepEqual(term.stdin.raw, []);
  const json = go(['review', '--json']);
  assert.equal(await json.done, 1);
  assert.equal(JSON.parse(out[0]).ok, false);
});

test('a bad filter or a stray word stops before any call', async (t) => {
  const { go, errs, server } = setup(t);
  assert.equal(await go(['review', '--stage', 'bogus']).done, 2);
  assert.equal(await go(['review', 'rae']).done, 2);
  assert.match(errs.join('\n'), /"bogus" is not a stage/);
  assert.match(errs.join('\n'), /does not take a name or a word on its own/);
  assert.equal(server.state.calls.length, 0);
});

test('signed out: the usual sign-in sentence', async (t) => {
  const { go, errs } = setup(t);
  const { done } = go(['review'], { deps: { getToken: async () => ({ token: '' }) } });
  assert.equal(await done, 1);
  assert.match(errs.join('\n'), /atris login/);
});

test('review is in the help text', async () => {
  const out = [];
  await nexusCommand(['--help'], { log: (line) => out.push(line) });
  assert.match(out.join('\n'), /atris nexus review \[--stage <stage>\] \[--list "<name>"\] \[--search "<words>"\] \[--due\] \[--restart\]/);
});

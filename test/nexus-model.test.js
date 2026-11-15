'use strict';

// Ported from atrisos-web app/dashboard/people/people-model.test.ts and
// people-list.test.ts, so the command line and the web page agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/nexus-model');

const NOW = new Date(2026, 10, 14, 12);
const me = { t: 'p', n: 'You', me: 1, d: 0 };

function map(people, extra = [], edges = []) {
  const nodes = [me, ...people, ...extra];
  return { nodes, edges: [...people.map((_, i) => [0, i + 1, 'knows']), ...edges] };
}

test('the loop: each status maps to its stage', () => {
  const at = (status) => m.loopOf({ status }, NOW);
  assert.deepEqual(at(undefined), { stage: 0, label: 'Found', off: false });
  assert.equal(at('prospect').label, 'Found');
  assert.deepEqual(at('sent'), { stage: 1, label: 'Reached out', off: false });
  assert.equal(at('replied').stage, 2);
  assert.deepEqual(at('met'), { stage: 3, label: 'Met', off: false });
  assert.deepEqual(at('proposal'), { stage: 3, label: 'Proposal out', off: false });
  assert.deepEqual(at('paying'), { stage: 4, label: 'Paying', off: false });
  assert.deepEqual(at('partner'), { stage: 5, label: 'Partner', off: false });
  assert.deepEqual(at('constructor'), { stage: 0, label: 'Found', off: false });
});

test('the loop: quiet, held, lost and gone people stay at the furthest stage they reached', () => {
  assert.deepEqual(m.loopOf({ status: 'silent', last: '2026-11-03' }, NOW), { stage: 1, label: 'Quiet since Nov 3', off: true });
  assert.deepEqual(m.loopOf({ status: 'silent', act: [['2026-10-01', 'They replied', 'Sure']] }, NOW), { stage: 2, label: 'Quiet', off: true });
  assert.deepEqual(m.loopOf({ status: 'hold' }, NOW), { stage: 2, label: 'On hold', off: true });
  assert.deepEqual(m.loopOf({ status: 'lost' }, NOW), { stage: 0, label: 'Lost', off: true });
  assert.equal(m.loopOf({ status: 'lost', act: [['2026-10-01', 'Email sent', '']] }, NOW).stage, 1);
  assert.deepEqual(m.loopOf({ status: 'left', act: [['2026-10-02', 'They replied', ''], ['2026-10-01', 'Email sent', '']] }, NOW), { stage: 2, label: 'Left', off: true });
});

test('closeness names the distance without naming the middle person', () => {
  assert.equal(m.closeness(1), 'Direct');
  assert.equal(m.closeness(2), 'One intro');
  assert.equal(m.closeness(3), '');
  assert.equal(m.closeness(undefined), '');
});

test('scores buyers you are talking to above strangers, and zeroes the lost', () => {
  const paying = m.measure({ t: 'p', n: 'A', status: 'paying', d: 1 });
  const stranger = m.measure({ t: 'p', n: 'B' });
  assert.ok(paying.score > stranger.score);
  assert.equal(m.measure({ t: 'p', n: 'C', status: 'lost', d: 1, title: 'CEO' }).score, 0);
  assert.equal(m.measure({ t: 'p', n: 'D', d: 2, x: { via: 'Jacob Effron' } }).move, 'Ask Jacob Effron for an intro');
  assert.equal(m.measure({ t: 'p', n: 'E', d: 2, x: { shared: 'climbing' } }).move, 'Open with climbing');
  assert.equal(m.measure({ t: 'p', n: 'F', status: 'silent' }).move, 'Find a warmer way in');
});

test('blanks generic moves in the table only', () => {
  const people = m.buildPeople(map([{ t: 'p', n: 'Pay', status: 'paying', d: 1 }, { t: 'p', n: 'Pal', status: 'partner', d: 1 }, { t: 'p', n: 'New', d: 1 }]), NOW);
  const by = (name) => people.rows.find((row) => row.name === name);
  assert.equal(by('Pay').move, 'Check in and reinforce the win');
  assert.equal(by('Pay').tableMove, '');
  assert.equal(by('Pal').tableMove, '');
  assert.equal(by('New').tableMove, 'Message them yourself');
});

test('hides unnamed Stripe customers unless searched for, and counts views without them', () => {
  const people = m.buildPeople(map([{ t: 'p', n: 'Stripe customer cus_123' }, { t: 'p', n: 'Ada' }]), NOW);
  assert.deepEqual(m.viewRows(people.rows, 'all', '').map((row) => row.name), ['Ada']);
  assert.deepEqual(m.viewRows(people.rows, 'all', 'stripe').map((row) => row.name), ['Stripe customer cus_123']);
  assert.deepEqual(m.viewCounts(people.rows), { all: 1, talk: 0, warm: 0, pay: 0 });
});

test('formats days', () => {
  assert.equal(m.shortDay('2026-11-03', NOW), 'Nov 3');
  assert.equal(m.shortDay('2025-01-09', NOW), 'Jan 9, 2025');
  assert.equal(m.shortDay('', NOW), '');
  assert.equal(m.daysSince('2026-11-10', NOW), 4);
  assert.equal(m.daysSince(undefined, NOW), Infinity);
});

test('the way in: shortest path through people, skipping grouping buckets', () => {
  // 0 You, 1 Jacob, 2 Dylan, 3 bucket, 4 Far
  const list = {
    nodes: [me, { t: 'p', n: 'Jacob', d: 1 }, { t: 'p', n: 'Dylan', d: 2 }, { t: 'c', n: 'Everyone', g: 1 }, { t: 'p', n: 'Far', d: 3 }],
    edges: [[0, 1, 'knows'], [1, 2, 'knows'], [0, 3, 'in'], [3, 4, 'in']],
  };
  const people = m.buildPeople(list, NOW);
  assert.deepEqual(m.route(people, 2), [0, 1, 2]);
  assert.equal(m.route(people, 4), null);
  assert.deepEqual(m.wayIn(people, 2), ['You', 'Jacob', 'Dylan']);
  assert.equal(m.wayIn(people, 1), null, 'direct people have no way in to show');
});

test('the way in falls back to the named middle person when the map has no path', () => {
  const people = m.buildPeople({ nodes: [me, { t: 'p', n: 'Dylan', d: 2, x: { via: 'Jacob Effron' } }], edges: [] }, NOW);
  assert.deepEqual(m.wayIn(people, 1), ['You', 'Jacob Effron', 'Dylan']);
});

test('the way in stops past three hops', () => {
  const chain = [me, ...['A', 'B', 'C', 'D'].map((n) => ({ t: 'p', n }))];
  const people = m.buildPeople({ nodes: chain, edges: [[0, 1, ''], [1, 2, ''], [2, 3, ''], [3, 4, '']] }, NOW);
  assert.deepEqual(m.route(people, 3), [0, 1, 2, 3]);
  assert.equal(m.route(people, 4), null);
});

test('lists people and orgs as ties, not places or buckets', () => {
  const list = {
    nodes: [me, { t: 'p', n: 'Ada', d: 1 }, { t: 'o', n: 'Globe' }, { t: 'l', n: 'Austin' }, { t: 'c', n: 'All', g: 1 }, { t: 'p', n: 'Bo' }],
    edges: [[0, 1, ''], [1, 2, ''], [1, 3, ''], [1, 4, ''], [1, 5, '']],
  };
  const people = m.buildPeople(list, NOW);
  assert.deepEqual(m.ties(people, 1), [{ at: 2, name: 'Globe', person: false }, { at: 5, name: 'Bo', person: true }]);
  assert.equal(people.byAt.get(1).city, 'Austin');
});

test('today puts the longest wait first, then stale meetings, then intros, then old friends', () => {
  const list = map([
    { t: 'p', n: 'Fresh reply', status: 'replied', d: 1, last: '2026-11-12' },
    { t: 'p', n: 'Old reply', status: 'replied', d: 1, last: '2026-10-01' },
    { t: 'p', n: 'Held', status: 'hold', d: 1, last: '2026-11-01' },
    { t: 'p', n: 'Met lately', status: 'met', d: 1, last: '2026-11-13' },
    { t: 'p', n: 'Met long ago', status: 'met', d: 1, last: '2026-11-01' },
    { t: 'p', n: 'Old friend', status: 'paying', d: 1, last: '2026-09-01' },
  ]);
  const feed = m.todayFeed(m.buildPeople(list, NOW), NOW);
  assert.deepEqual(feed.map((item) => item.name), ['Old reply', 'Held', 'Fresh reply', 'Met long ago', 'Old friend']);
  assert.equal(feed[0].line, 'Wrote back. Answer them.');
  assert.equal(feed[3].line, 'Met you. Follow up while it is fresh.');
  assert.equal(feed[4].line, 'A month since you talked. Check in.');
});

test('today suggests intros only through people already talking to you, at most two per middle person', () => {
  const intro = (n, via, title = 'Founder') => ({ t: 'p', n, d: 2, title, x: { via } });
  const list = map([
    { t: 'p', n: 'Jacob', status: 'met', d: 1, last: '2026-11-13' },
    { t: 'p', n: 'Cold Carl', status: 'prospect', d: 1 },
    intro('One', 'Jacob'), intro('Two', 'Jacob'), intro('Three', 'Jacob'),
    intro('Four', 'Cold Carl'),
  ]);
  const feed = m.todayFeed(m.buildPeople(list, NOW), NOW);
  assert.deepEqual(feed.map((item) => item.name), ['One', 'Two']);
  assert.equal(feed[0].line, 'One intro away, through Jacob.');
});

test('today never shows more than five, one per person, and can be empty', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ t: 'p', n: `P${i}`, status: 'replied', d: 1, last: '2026-11-01' }));
  const feed = m.todayFeed(m.buildPeople(map(many), NOW), NOW);
  assert.equal(feed.length, 5);
  assert.equal(new Set(feed.map((item) => item.at)).size, 5);
  assert.deepEqual(m.todayFeed(m.buildPeople(map([{ t: 'p', n: 'Quiet one', d: 3 }]), NOW), NOW), []);
});

// ---- the saved list ----

const added = (list, name = 'Ada Byron') => m.applyChange(list, { do: 'add', name, title: 'Actress', city: 'Los Angeles, CA', email: 'ada@example.com' });

test('a new list holds only the owner', () => {
  assert.deepEqual(m.starter().nodes, [{ t: 'p', n: 'You', me: 1, d: 0 }]);
});

test('adds a person tied directly to the owner', () => {
  const list = added(m.starter());
  const ada = list.nodes[1];
  assert.equal(ada.n, 'Ada Byron');
  assert.equal(ada.d, 1);
  assert.equal(ada.status, 'met');
  assert.equal(ada.mail, 1);
  assert.equal(ada.cid, 1);
  assert.deepEqual(list.edges, [[0, 1, 'knows']]);
});

test('refuses a missing name and a repeat', () => {
  assert.equal(m.applyChange(m.starter(), { do: 'add', name: '  ' }), 'A name is needed.');
  assert.equal(m.applyChange(added(m.starter()), { do: 'add', name: 'ada byron' }), 'Ada Byron is already on your map.');
});

test('changes status, details and notes only for the named person', () => {
  let list = added(m.starter());
  list = m.applyChange(list, { do: 'status', at: 1, who: 'Ada Byron', status: 'paying' });
  list = m.applyChange(list, { do: 'details', at: 1, who: 'Ada Byron', company: 'Globe' });
  list = m.applyChange(list, { do: 'note', at: 1, who: 'Ada Byron', text: 'Loves climbing.' });
  assert.equal(list.nodes[1].status, 'paying');
  assert.equal(list.nodes[1].co, 'Globe');
  assert.equal(list.nodes[1].act[0][2], 'Loves climbing.');
  assert.equal(m.applyChange(list, { do: 'status', at: 1, who: 'Someone Else', status: 'lost' }), 'That person is not on your map.');
  assert.equal(m.applyChange(list, { do: 'status', at: 0, who: 'You', status: 'lost' }), 'That person is not on your map.');
  assert.equal(m.applyChange(list, { do: 'status', at: 1, who: 'Ada Byron', status: 'hacked' }), 'That status is not one we know.');
  assert.equal(m.applyChange(list, { do: 'status', at: 1, who: 'Ada Byron', status: ['paying'] }), 'That status is not one we know.');
  assert.equal(m.applyChange(list, { do: 'status', at: '1', who: 'Ada Byron', status: 'paying' }), 'That person is not on your map.');
  assert.equal(m.applyChange(list, { do: 'wipe', at: 1, who: 'Ada Byron' }), 'That change is not one we know.');
  assert.equal(m.applyChange(list, { do: 'note', at: 1, who: 'Ada Byron', text: '   ' }), 'The note is empty.');
});

test('queues changes only for a map fed from the owner\'s computer', () => {
  assert.equal(added(m.starter()).pending, undefined);
  const list = added({ ...m.starter(), mine: 'mac' });
  assert.deepEqual(list.pending, [{ do: 'add', name: 'Ada Byron', title: 'Actress', company: undefined, city: 'Los Angeles, CA', email: 'ada@example.com', note: undefined }]);
});

test('refuses a map that would not fit', () => {
  const big = { ...m.starter(), nodes: [...m.starter().nodes, { t: 'p', n: 'Big', note: 'x'.repeat(960000) }] };
  assert.equal(m.applyChange(big, { do: 'add', name: 'One More' }), 'Your map is full. Remove some people before adding more.');
});

test('reads only real maps', () => {
  assert.equal(m.readList('not json'), null);
  assert.equal(m.readList('{"nodes":1}'), null);
  assert.equal(m.readList('null'), null);
  assert.equal(m.readList(JSON.stringify(m.starter())).nodes.length, 1);
  assert.equal(m.readList('{"nodes":[{"t":"p","n":"A"}],"edges":[[0,5,"knows"]]}'), null);
  assert.equal(m.readList('{"nodes":[{"t":"p","n":7}],"edges":[]}'), null);
  assert.equal(m.readList('{"nodes":[{"t":"p","n":"A","act":"x"}],"edges":[]}'), null);
});

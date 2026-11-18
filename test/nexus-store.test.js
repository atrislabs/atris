'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../lib/nexus-store');
const model = require('../lib/nexus-model');

test('money parses to whole cents with no float drift, and prints as dollars with cents', () => {
  for (const [text, cents] of [['50', 5000], ['$1,200.50', 120050], ['0.1', 10], ['19.99', 1999], ['0', 0], ['7.5', 750]]) {
    assert.equal(S.parseMoney(text), cents, text);
  }
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', '$', '1,2,3x', '99999999999999999999']) assert.equal(S.parseMoney(bad), null, bad);
  assert.equal(S.formatMoney(0), '$0.00');
  assert.equal(S.formatMoney(5), '$0.05');
  assert.equal(S.formatMoney(120050), '$1,200.50');
  assert.equal(S.formatMoney(100000000), '$1,000,000.00');
});

test('days: real dates only, today and tomorrow follow the local day, clear means none', () => {
  const now = new Date(2026, 11, 31, 23, 30);
  assert.deepEqual(S.parseDay('2026-12-15', now), { ok: true, day: '2026-12-15' });
  assert.deepEqual(S.parseDay('today', now), { ok: true, day: '2026-12-31' });
  assert.deepEqual(S.parseDay('Tomorrow', now), { ok: true, day: '2027-01-01' });
  assert.deepEqual(S.parseDay('clear', now), { ok: true, day: null });
  for (const bad of ['2026-02-30', '2026-13-01', '12/15/2026', 'soon', '']) assert.equal(S.parseDay(bad, now).ok, false, bad);
});

test('stage words match the page: the loop words, the file words, and off-loop words at their furthest stage', () => {
  const pairs = { found: 'found', reached: 'reached_out', reached_out: 'reached_out', replied: 'replied', met: 'met', paying: 'paying', partner: 'partner', prospect: 'found', sent: 'reached_out', proposal: 'met', silent: 'reached_out', hold: 'replied', lost: 'found', left: 'found' };
  for (const [word, stage] of Object.entries(pairs)) assert.equal(S.stageFromWord(word), stage, word);
  assert.equal(S.stageFromWord('married'), null);
  assert.equal(S.statusOf({ stage: 'reached_out', status_raw: 'silent' }), 'silent');
  assert.equal(S.statusOf({ stage: 'met', status_raw: 'silent' }), 'met', 'a stale word gives way to the stage');
  assert.equal(S.statusOf(null), 'prospect');
});

test('a store card becomes the same person the page shows, with ties and touches', () => {
  const card = {
    id: 'a', name: 'Rae Sample', title: 'Founder', company_name: 'Sample Co', location_raw: 'Austin, TX', linkedin_url: 'https://www.linkedin.com/in/rae', x_handle: 'rae', website: 'https://sample.test',
    private: { stage: 'replied', closeness: 1, email: 'rae@example.test', note: 'n', last_touch_at: '2026-11-13T10:00:00+00:00', group_name: 'G', next_move: 'Call', paid_cents: 100, paid_checked: true, via_person_id: 'v' },
  };
  const touches = [{ kind: 'sent', body: 'hello', at: '2026-11-10T09:00:00+00:00' }, { kind: 'note', body: 'x', at: '2026-11-09T09:00:00+00:00' }, { kind: 'reply', body: 'Email sent hi', at: '2026-11-08T09:00:00+00:00' }];
  const person = S.cardToPerson(card, touches, new Map([['v', 'Via Name']]));
  assert.equal(person.status, 'replied');
  assert.equal(person.d, 1);
  assert.equal(person.mail, 1);
  assert.equal(person.last, '2026-11-13');
  assert.deepEqual(person.links, ['https://www.linkedin.com/in/rae', 'https://x.com/rae', 'https://sample.test']);
  assert.deepEqual(person.act, [['2026-11-10', 'Email sent', 'hello'], ['2026-11-09', 'Note', 'x'], ['2026-11-08', 'They replied', 'Email sent hi']]);
  assert.equal(person.x.via, 'Via Name');
  assert.equal(person.x.chk, 1);

  const list = S.cardToList(card, [{ other_person_id: 'b', other_name: 'Bo Example', label: 'knows' }], touches, 'Via Name');
  const people = model.buildPeople(list, new Date(2026, 10, 14));
  assert.equal(people.rows.length, 2);
  assert.equal(people.rows[0].loop.label, 'Replied');
  assert.deepEqual(model.ties(people, 1).map((t) => t.name), ['Bo Example']);
});

test('cities match by name, with the region or country when more than one share it', () => {
  const places = [
    { id: '1', city: 'London', region: null, country: 'United Kingdom' },
    { id: '2', city: 'London', region: 'Ontario', country: 'Canada' },
    { id: '3', city: 'Austin', region: 'Texas', country: 'United States' },
  ];
  assert.deepEqual(S.cityMatches(places, 'austin').map((p) => p.id), ['3']);
  assert.deepEqual(S.cityMatches(places, 'London').map((p) => p.id), ['1', '2']);
  assert.deepEqual(S.cityMatches(places, 'london, united kingdom').map((p) => p.id), ['1']);
  assert.deepEqual(S.cityMatches(places, 'London,Ontario').map((p) => p.id), ['2']);
  assert.deepEqual(S.cityMatches(places, 'paris'), []);
  assert.deepEqual(S.cityMatches(places, ''), []);
});

test('a failed store answer becomes one plain sentence', () => {
  assert.equal(S.plainError({ status: 422, data: { detail: 'A name, email, LinkedIn link or X handle is needed.' } }), 'A name, email, LinkedIn link or X handle is needed.');
  assert.equal(S.plainError({ status: 422, data: { detail: [{ msg: 'Value error, At most 2000 people in one import.' }] } }), 'At most 2000 people in one import.');
  assert.equal(S.plainError({ status: 418, data: null }), 'The people store answered 418.');
});

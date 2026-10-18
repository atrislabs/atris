'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const AT = '2026-10-15T10:00:00.000Z';
function event(overrides = {}) {
  return { id: 'evt-new', campaign_id: 'cmp-one', type: 'paused', at: AT,
    origin: 'remote', seq: 1, actor: 'human:operator', data: {}, ...overrides };
}
function start(overrides = {}) {
  return event({ type: 'campaign_started',
    data: { title: 'Owned history', judge: 'exit 1', budget: 100 }, ...overrides });
}
function memory(t) {
  const store = createMemoryStore({ origin: 'local', now: () => AT });
  t.after(() => store.close());
  return store;
}

test('memory ingest validates before duplicate identity and duplicates win over later refusals', (t) => {
  const store = memory(t);
  store.ingest(start({ id: 'evt-base', origin: 'seed' }));
  store.ingest(event({ id: 'evt-mission', origin: 'other', type: 'step', data: { mission_id: 'm-one' } }));
  const before = store.read('cmp-one');
  assert.throws(() => store.ingest(event({ id: 'evt-base', type: 'not-an-event' })),
    { code: 'invalid_event', message: 'invalid not-an-event: unknown_type' });
  assert.equal(store.ingest(event({ id: 'evt-base', campaign_id: 'cmp-two', origin: 'other',
    type: 'step', data: { mission_id: 'm-one' } })), false);
  assert.deepEqual(store.read('cmp-one'), before);
  assert.deepEqual(store.read('cmp-two'), []);
  assert.equal(store.campaignForMission('m-one'), 'cmp-one');
});

test('memory append and ingest share identities without adding append refusals', (t) => {
  const store = memory(t);
  const first = store.append(start({ id: 'evt-local' }));
  const repeated = store.append(event({ id: 'evt-local' }));
  assert.deepEqual([first.origin, first.seq, repeated.origin, repeated.seq], ['local', 1, 'local', 2]);
  assert.equal(store.ingest(event({ id: 'evt-local', campaign_id: 'cmp-two' })), false);
  assert.throws(() => store.ingest(event({ id: 'evt-clash', origin: 'local', seq: 1 })),
    { code: 'seq_conflict', message: 'origin local seq 1 is already evt-local' });
  assert.equal(store.ingest(event({ id: 'evt-remote', seq: 4 })), true);
  const after = store.append(event({ id: 'evt-after' }), { expectedVersion: 3 });
  assert.equal(after.seq, 3);
  assert.deepEqual(store.read('cmp-one').map(({ id, seq }) => [id, seq]),
    [['evt-local', 1], ['evt-local', 2], ['evt-remote', 4], ['evt-after', 3]]);
});

test('memory ingest refusals do not reserve otherwise reusable identities or sequences', (t) => {
  const store = memory(t);
  store.ingest(start({ id: 'evt-start', origin: 'seed' }));
  assert.throws(() => store.ingest(event({ id: 'evt-retry', seq: 5, type: 'not-an-event' })), { code: 'invalid_event' });
  assert.equal(store.ingest(event({ id: 'evt-retry', seq: 5 })), true);
  store.ingest(event({ id: 'evt-owner', seq: 6, type: 'step', data: { mission_id: 'm-one' } }));
  assert.throws(() => store.ingest(event({ id: 'evt-refused', campaign_id: 'cmp-two', origin: 'other',
    type: 'step', data: { mission_id: 'm-one' } })),
  { code: 'mission_in_other_campaign', message: 'mission m-one already belongs to cmp-one' });
  assert.equal(store.ingest(event({ id: 'evt-refused', campaign_id: 'cmp-two', origin: 'other' })), true);
  assert.throws(() => store.ingest(event({ id: 'evt-seq-retry', seq: 5 })),
    { code: 'seq_conflict', message: 'origin remote seq 5 is already evt-retry' });
  assert.equal(store.ingest(event({ id: 'evt-seq-retry', origin: 'other', seq: 2 })), true);
  assert.deepEqual(store.campaignIds(), ['cmp-one']);
});

test('memory committed rows and returned views stay detached from callers', (t) => {
  const store = memory(t);
  const input = start({ id: 'evt-start' });
  const returned = store.append(input);
  input.data.title = 'caller changed';
  returned.id = 'returned changed';
  returned.data.title = 'returned changed';
  const remote = event({ id: 'evt-remote', data: { note: { text: 'original' } } });
  store.ingest(remote);
  remote.id = 'caller changed';
  remote.data.note.text = 'caller changed';
  const read = store.read('cmp-one');
  read[0].data.title = 'read changed';
  read[1].id = 'read changed';
  read[1].data.note.text = 'read changed';
  assert.deepEqual(store.read('cmp-one').map(({ id }) => id), ['evt-start', 'evt-remote']);
  assert.equal(store.read('cmp-one')[0].data.title, 'Owned history');
  assert.equal(store.read('cmp-one')[1].data.note.text, 'original');
  assert.equal(store.version('cmp-one'), 2);
  assert.equal(getCampaign(store, 'cmp-one').title, 'Owned history');
});

function seedTwo(store) {
  store.ingest(event({ id: 'evt-first', origin: 'first' }));
  store.ingest(event({ id: 'evt-second', origin: 'second' }));
}

test('memory ingest keeps the existing direct getter reads on a new identity', (t) => {
  const store = memory(t);
  seedTwo(store);
  let reads = 0;
  const input = event({ origin: 'new-origin' });
  Object.defineProperty(input, 'id', { enumerable: true, configurable: true,
    get() { reads++; return 'evt-getter'; } });
  assert.equal(store.ingest(input), true);
  // Two validator reads, two actual stored-row comparisons, one JSON clone.
  assert.equal(reads, 5);
  assert.deepEqual(store.read('cmp-one').map(({ id }) => id), ['evt-first', 'evt-second', 'evt-getter']);
});

test('memory ingest preserves stateful getter identity changes during the legacy scan', (t) => {
  const store = memory(t);
  seedTwo(store);
  let reads = 0;
  const input = event({ origin: 'new-origin' });
  Object.defineProperty(input, 'id', { enumerable: true, configurable: true,
    get() { reads++; return reads === 4 ? 'evt-second' : 'evt-missing'; } });
  assert.equal(store.ingest(input), false);
  assert.equal(reads, 4);
  assert.deepEqual(store.read('cmp-one').map(({ id }) => id), ['evt-first', 'evt-second']);
});

test('memory ingest adds no reflective Proxy traps before actual serialization', (t) => {
  const store = memory(t);
  seedTwo(store);
  const target = event({ id: 'evt-proxy', origin: 'new-origin' });
  const reflected = [];
  let idReads = 0;
  let toJSONReads = 0;
  const input = new Proxy(target, {
    get(value, key, receiver) {
      if (key === 'id') idReads++;
      if (key === 'toJSON') { toJSONReads++; reflected.push('toJSON'); }
      return Reflect.get(value, key, receiver);
    },
    ownKeys(value) { reflected.push('keys'); return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(value, key) {
      reflected.push('descriptor:' + String(key));
      return Reflect.getOwnPropertyDescriptor(value, key);
    },
    getPrototypeOf(value) { reflected.push('prototype'); return Reflect.getPrototypeOf(value); },
  });
  assert.equal(store.ingest(input), true);
  assert.equal(idReads, 5);
  assert.equal(toJSONReads, 1);
  assert.deepEqual(reflected, ['toJSON', 'keys', ...Object.keys(target).map((key) => 'descriptor:' + key)]);
  assert.equal(store.read('cmp-one').at(-1).id, 'evt-proxy');
});

test('memory duplicate Proxy does not invoke descriptor ownKeys or prototype traps', (t) => {
  const store = memory(t);
  store.ingest(event({ id: 'evt-known' }));
  const expected = new Error('reflection was not part of this duplicate lookup');
  const reflected = [];
  let idReads = 0;
  const input = new Proxy(event({ id: 'evt-known', origin: 'different' }), {
    get(value, key, receiver) { if (key === 'id') idReads++; return Reflect.get(value, key, receiver); },
    ownKeys() { reflected.push('keys'); throw expected; },
    getOwnPropertyDescriptor() { reflected.push('descriptor'); throw expected; },
    getPrototypeOf() { reflected.push('prototype'); throw expected; },
  });
  assert.equal(store.ingest(input), false);
  assert.equal(idReads, 3);
  assert.deepEqual(reflected, []);
  assert.equal(store.version('cmp-one'), 1);
});

test('memory ingest indexes the first actual serialized row rather than caller keys', (t) => {
  const store = memory(t);
  const first = event({ id: 'evt-input-one', origin: 'input-one', toJSON() {
    return event({ id: 'evt-stored-first', origin: 'serialized', seq: 7 });
  } });
  const second = event({ id: 'evt-input-two', origin: 'input-two', toJSON() {
    return event({ id: 'evt-stored-second', origin: 'serialized', seq: 7 });
  } });
  assert.equal(store.ingest(first), true);
  assert.equal(store.ingest(second), true);
  assert.equal(store.ingest(event({ id: 'evt-stored-first', origin: 'unrelated' })), false);
  assert.throws(() => store.ingest(event({ id: 'evt-conflict', origin: 'serialized', seq: 7 })),
    { code: 'seq_conflict', message: 'origin serialized seq 7 is already evt-stored-first' });
  assert.equal(store.ingest(event({ id: 'evt-input-one', origin: 'input-one', seq: 2 })), true);
  assert.deepEqual(store.read('cmp-one').map(({ id }) => id), ['evt-stored-first', 'evt-stored-second', 'evt-input-one']);
});

test('memory ingest preserves a serialized null row and its later lookup error', (t) => {
  const store = memory(t);
  assert.equal(store.ingest(event({ toJSON() { return null; } })), true);
  assert.throws(() => store.ingest(event({ id: 'evt-after-null', origin: 'next' })),
    (error) => error instanceof TypeError && error.message.includes("reading 'id'"));
});

test('memory serialization failures retain the existing campaign mission and sequence effects', (t) => {
  const store = memory(t);
  const expected = new Error('actual serialization failure');
  const failed = start({ id: 'evt-failed', origin: 'local', seq: 7,
    data: { title: 'Owned history', judge: 'exit 1', budget: 100, mission_id: 'm-partial' },
    toJSON() { throw expected; } });
  assert.throws(() => store.ingest(failed), (error) => error === expected);
  assert.equal(store.version('cmp-one'), 0);
  assert.deepEqual(store.read('cmp-one'), []);
  assert.deepEqual(store.campaignIds(), ['cmp-one']);
  assert.equal(store.campaignForMission('m-partial'), 'cmp-one');
  assert.throws(() => store.ingest(event({ id: 'evt-refused', campaign_id: 'cmp-two', origin: 'other',
    type: 'step', data: { mission_id: 'm-partial' } })), { code: 'mission_in_other_campaign' });
  const after = store.append(event({ id: 'evt-after-failure' }), { expectedVersion: 0 });
  assert.equal(after.seq, 8);
  assert.equal(store.ingest(event({ id: 'evt-failed', origin: 'local', seq: 7 })), true);
  assert.equal(store.append(event({ id: 'evt-next' })).seq, 9);
  assert.deepEqual(store.read('cmp-one').map(({ id, seq }) => [id, seq]),
    [['evt-after-failure', 8], ['evt-failed', 7], ['evt-next', 9]]);
});

test('memory recursive ingest serialization retains inner-first conflict identity', (t) => {
  const store = memory(t);
  let innerResult;
  const outer = event({ id: 'evt-outer', toJSON() {
    innerResult = store.ingest(event({ id: 'evt-inner' }));
    return event({ id: 'evt-outer' });
  } });
  assert.equal(store.ingest(outer), true);
  assert.equal(innerResult, true);
  assert.deepEqual(store.read('cmp-one').map(({ id, seq }) => [id, seq]), [['evt-inner', 1], ['evt-outer', 1]]);
  assert.throws(() => store.ingest(event({ id: 'evt-clash' })),
    { code: 'seq_conflict', message: 'origin remote seq 1 is already evt-inner' });
  assert.equal(store.ingest(event({ id: 'evt-outer', origin: 'different' })), false);

  // An unrelated accessor is safe for lookup but still runs at real serialization.
  const accessorStore = memory(t);
  const stages = [];
  let innerAccepted;
  const withAccessor = event({ id: 'evt-accessor-outer', origin: 'accessor' });
  Object.defineProperty(withAccessor, 'note', { enumerable: true, get() {
    stages.push(accessorStore.version('cmp-one'));
    innerAccepted = accessorStore.ingest(event({ id: 'evt-accessor-inner', origin: 'accessor' }));
    return 'serialized once';
  } });
  assert.equal(accessorStore.ingest(withAccessor), true);
  assert.deepEqual(stages, [0]);
  assert.equal(innerAccepted, true);
  assert.deepEqual(accessorStore.read('cmp-one').map(({ id, seq }) => [id, seq]),
    [['evt-accessor-inner', 1], ['evt-accessor-outer', 1]]);
  assert.equal(accessorStore.read('cmp-one').at(-1).note, 'serialized once');
  assert.equal(accessorStore.ingest(withAccessor), false);
  assert.deepEqual(stages, [0]);
  assert.throws(() => accessorStore.ingest(event({ id: 'evt-accessor-clash', origin: 'accessor' })),
    { code: 'seq_conflict', message: 'origin accessor seq 1 is already evt-accessor-inner' });
});

test('memory recursive append serialization retains the second return clone and actual row order', (t) => {
  const store = memory(t);
  store.append(start({ id: 'evt-start' }));
  const innerSequences = [];
  const data = { mission_id: 'm-outer', toJSON() {
    innerSequences.push(store.append(event({ id: 'evt-inner' })).seq);
    return { mission_id: 'm-outer' };
  } };
  const returned = store.append(event({ id: 'evt-outer', type: 'step', data }));
  assert.deepEqual(innerSequences, [3, 4]);
  assert.equal(returned.seq, 2);
  assert.deepEqual(store.read('cmp-one').map(({ id, seq }) => [id, seq]),
    [['evt-start', 1], ['evt-inner', 3], ['evt-outer', 2], ['evt-inner', 4]]);
  assert.equal(store.ingest(event({ id: 'evt-outer', origin: 'different' })), false);
  assert.throws(() => store.ingest(event({ id: 'evt-clash', origin: 'local', seq: 2 })),
    { code: 'seq_conflict', message: 'origin local seq 2 is already evt-outer' });
  assert.equal(store.append(event({ id: 'evt-after' })).seq, 5);
});

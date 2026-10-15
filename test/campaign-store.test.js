'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  campaignDbPath, createMemoryStore, createSqliteStore, getCampaign, listCampaigns, newCampaignId,
} = require('../lib/campaign-store');
const { fold } = require('../lib/campaign-core');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-store-'));
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 15, 10, 0, clock++)).toISOString();

const start = (id) => ({
  campaign_id: id, type: 'campaign_started', actor: 'mission-lead',
  data: { title: 'Campaign ships across Atris', judge: 'node scripts/campaign-conformance.js', budget: 500 },
});

function adapters() {
  const dir = tempDir();
  return [
    ['memory', () => createMemoryStore({ origin: 'laptop', now })],
    ['sqlite', () => createSqliteStore(path.join(dir, `atris-${Math.random().toString(16).slice(2)}.db`), { origin: 'laptop', now })],
  ];
}

for (const [kind, make] of adapters()) {
  test(`${kind}: append fills id, origin, and a per-origin sequence`, () => {
    const store = make();
    const a = store.append(start('cmp-ship'));
    const b = store.append({ campaign_id: 'cmp-ship', type: 'seat_filled', actor: 'mission-lead', data: { member: 'builder', role: 'builder' } });
    assert.match(a.id, /^evt-/);
    assert.equal(a.origin, 'laptop');
    assert.deepEqual([a.seq, b.seq], [1, 2]);
    assert.equal(store.version('cmp-ship'), 2);
    assert.deepEqual(store.read('cmp-ship').map((e) => e.type), ['campaign_started', 'seat_filled']);
    store.close();
  });

  test(`${kind}: refuses events for unknown campaigns, double starts, and stale versions`, () => {
    const store = make();
    assert.throws(() => store.append({ campaign_id: 'cmp-none', type: 'paused', actor: 'human:keshav', data: {} }), { code: 'unknown_campaign' });
    store.append(start('cmp-ship'));
    assert.throws(() => store.append(start('cmp-ship')), { code: 'campaign_exists' });
    assert.throws(() => store.append({ campaign_id: 'cmp-ship', type: 'paused', actor: 'human:keshav', data: {} }, { expectedVersion: 0 }), { code: 'version_conflict' });
    store.append({ campaign_id: 'cmp-ship', type: 'paused', actor: 'human:keshav', data: {} }, { expectedVersion: 1 });
    assert.throws(() => store.append({ campaign_id: 'cmp-ship', type: 'mission_ended', actor: 'builder', data: { mission_id: 'm1', outcome: 'kept' } }), { code: 'invalid_event' });
    assert.equal(store.version('cmp-ship'), 2);
    store.close();
  });

  test(`${kind}: a mission belongs to at most one campaign`, () => {
    const store = make();
    store.append(start('cmp-one'));
    store.append(start('cmp-two'));
    store.append({ campaign_id: 'cmp-one', type: 'mission_started', actor: 'builder', data: { mission_id: 'm1', member: 'builder' } });
    assert.equal(store.campaignForMission('m1'), 'cmp-one');
    assert.throws(() => store.append({ campaign_id: 'cmp-two', type: 'mission_started', actor: 'builder', data: { mission_id: 'm1', member: 'builder' } }), { code: 'mission_in_other_campaign' });
    store.close();
  });

  test(`${kind}: ingest keeps events from other computers once, by id`, () => {
    const store = make();
    store.append(start('cmp-ship'));
    const remote = { id: 'evt-ec2-1', campaign_id: 'cmp-ship', type: 'judge_ran', at: now(), origin: 'ec2-business', seq: 1, actor: 'judge', data: { passed: false } };
    assert.equal(store.ingest(remote), true);
    assert.equal(store.ingest(remote), false);
    assert.throws(() => store.ingest({ ...remote, id: 'evt-ec2-other' }), { code: 'seq_conflict' });
    assert.equal(store.read('cmp-ship').length, 2);
    store.close();
  });

  test(`${kind}: replay is stable (fold, fold again, identical)`, () => {
    const store = make();
    store.append(start('cmp-ship'));
    store.append({ campaign_id: 'cmp-ship', type: 'mission_started', actor: 'builder', data: { mission_id: 'm1', member: 'builder' } });
    store.append({ campaign_id: 'cmp-ship', type: 'mission_ended', actor: 'builder', data: { mission_id: 'm1', outcome: 'kept', cost_usd: 2.22 } });
    const first = getCampaign(store, 'cmp-ship');
    const second = fold(store.read('cmp-ship'));
    assert.deepEqual(second, first);
    assert.equal(first.budget.spent, 2.22);
    assert.equal(first.judge_due, true);
    assert.deepEqual(listCampaigns(store).map((c) => c.id), ['cmp-ship']);
    store.close();
  });
}

test('sqlite: a corrupt row fails closed instead of being skipped', () => {
  const file = path.join(tempDir(), 'atris.db');
  const store = createSqliteStore(file, { origin: 'laptop', now });
  store.append(start('cmp-ship'));
  store.close();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec("UPDATE events SET data = '{not json' WHERE type = 'campaign_started'");
  db.close();
  const reopened = createSqliteStore(file, { now });
  assert.throws(() => reopened.read('cmp-ship'), { code: 'corrupt_event' });
  reopened.close();
});

test('sqlite: the origin id survives reopening the file', () => {
  const file = path.join(tempDir(), 'atris.db');
  const first = createSqliteStore(file, { now });
  const origin = first.origin;
  first.close();
  const second = createSqliteStore(file, { now });
  assert.equal(second.origin, origin);
  assert.match(origin, /^c-[0-9a-f]{8}$/);
  second.close();
});

test('sqlite: two processes appending at once lose nothing', async () => {
  const file = path.join(tempDir(), 'atris.db');
  const seed = createSqliteStore(file, { origin: 'laptop', now });
  seed.append(start('cmp-ship'));
  seed.close();
  const storePath = path.resolve(__dirname, '..', 'lib', 'campaign-store.js');
  const writer = (name) => `
    const { createSqliteStore } = require(${JSON.stringify(storePath)});
    const store = createSqliteStore(${JSON.stringify(file)});
    for (let i = 0; i < 40; i++) {
      store.append({ campaign_id: 'cmp-ship', type: 'step', actor: '${name}', data: { mission_id: '${name}-' + i } });
    }
    store.close();
  `;
  const run = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', writer(name)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  await Promise.all([run('alpha'), run('beta')]);
  const store = createSqliteStore(file);
  const events = store.read('cmp-ship');
  assert.equal(events.length, 81);
  const seqs = events.map((e) => e.seq);
  assert.equal(new Set(seqs).size, 81);
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 81 }, (_, i) => i + 1));
  store.close();
});

test('the store lives in the main checkout, and tests can point it elsewhere', () => {
  const saved = process.env.ATRIS_CAMPAIGN_DB;
  try {
    delete process.env.ATRIS_CAMPAIGN_DB;
    const root = tempDir();
    assert.equal(campaignDbPath(root), path.join(root, '.atris', 'state', 'atris.db'));
    process.env.ATRIS_CAMPAIGN_DB = '/tmp/elsewhere.db';
    assert.equal(campaignDbPath(root), '/tmp/elsewhere.db');
  } finally {
    if (saved === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
    else process.env.ATRIS_CAMPAIGN_DB = saved;
  }
});

test('campaign ids are short, plain, and valid', () => {
  assert.match(newCampaignId('Campaign ships across Atris!'), /^cmp-campaign-ships-across-at-[0-9a-f]{4}$/);
  assert.match(newCampaignId(''), /^cmp-[0-9a-f]{4}$/);
});

test("sqlite: any event naming a mission ties it to one campaign, and ingest alone never invents a campaign", () => {
  const store = createSqliteStore(path.join(tempDir(), "atris.db"), { origin: "laptop", now });
  store.append(start("cmp-one"));
  store.append(start("cmp-two"));
  store.ingest({ id: "evt-step", campaign_id: "cmp-one", type: "step", at: now(), origin: "ec2", seq: 1, actor: "builder", data: { mission_id: "m9" } });
  assert.throws(() => store.append({ campaign_id: "cmp-two", type: "mission_started", actor: "builder", data: { mission_id: "m9", member: "builder" } }), { code: "mission_in_other_campaign" });
  store.ingest({ id: "evt-orphan", campaign_id: "cmp-ghost", type: "paused", at: now(), origin: "ec2", seq: 2, actor: "human:keshav", data: {} });
  assert.deepEqual(store.campaignIds(), ["cmp-one", "cmp-two"]);
  assert.throws(() => store.append({ campaign_id: "cmp-ghost", type: "resumed", actor: "human:keshav", data: {} }), { code: "unknown_campaign" });
  store.close();
});

test("the store path is the same from any folder inside a checkout", () => {
  const saved = process.env.ATRIS_CAMPAIGN_DB;
  try {
    delete process.env.ATRIS_CAMPAIGN_DB;
    const root = tempDir();
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "lib", "deep"), { recursive: true });
    assert.equal(campaignDbPath(path.join(root, "lib", "deep")), path.join(root, ".atris", "state", "atris.db"));
  } finally {
    if (saved === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
    else process.env.ATRIS_CAMPAIGN_DB = saved;
  }
});

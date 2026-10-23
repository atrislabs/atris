'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fold } = require('../lib/campaign-core');
const { createMemoryStore, createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { summarizeTrace, summarizeStoreRsi, selectNextCampaigns } = require('../lib/campaign-rsi');
const { rankCampaignMembers, makeLoop } = require('../lib/campaign-loop');

function pair() {
  const rows = [
    [0, 'campaign_started', { title:'A recovery must follow completion order', owner:'recovering-worker', seats:[{ member:'warm-worker', role:'cli' }], judge:'false', budget:10 }],
    [1, 'judge_ran', { passed:false, reading:0 }],
    [2, 'mission_proposed', { mission_id:'m-f1', member:'recovering-worker' }],
    [3, 'mission_started', { mission_id:'m-f2', member:'recovering-worker' }],
    [4, 'mission_proposed', { mission_id:'m-k', member:'recovering-worker' }],
    [5, 'mission_started', { mission_id:'m-f1', member:'recovering-worker' }],
    [6, 'mission_started', { mission_id:'m-k', member:'recovering-worker' }],
    [10, 'mission_ended', { mission_id:'m-f1', outcome:'failed', cost_usd:0 }],
    [11, 'mission_ended', { mission_id:'m-f2', outcome:'failed', cost_usd:0 }],
    [12, 'mission_ended', { mission_id:'m-k', outcome:'kept', cost_usd:0 }],
    [13, 'judge_ran', { passed:false, reading:0.2 }],
  ];
  const normal = rows.map(([second, type, data], i) => ({ id:'local-order-'+(i+1), campaign_id:'cmp-local-order', type,
    at:'2026-10-17T00:00:'+String(second).padStart(2, '0')+'Z', origin:'owned-local-order', seq:i+1,
    actor:type === 'judge_ran' ? 'judge' : 'recovering-worker', data }));
  const swapped = structuredClone(normal);
  [swapped[2].at, swapped[4].at] = [swapped[4].at, swapped[2].at];
  return [normal, swapped];
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function ownedStores(t) {
  const key = crypto.randomBytes(32), cwd = process.cwd();
  const env = () => Object.fromEntries(Object.keys(process.env).sort().map(k => [k, crypto.createHmac('sha256', key).update(process.env[k]).digest('hex')]));
  const before = env(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'lfo-')), marker = path.join(root, 'foreign');
  t.after(() => {
    try { assert.equal(fs.readFileSync(marker, 'utf8'), 'retain'); }
    finally { fs.rmSync(root, { recursive:true, force:true }); }
    assert.deepEqual(env(), before); assert.equal(process.cwd(), cwd);
  });
  fs.writeFileSync(marker, 'retain');
  return async (kind, events, label, read) => {
    const input = JSON.stringify(events); freeze(events);
    const options = { origin:'owned-local-reader', now:() => '2026-10-17T00:01:00Z' };
    const store = kind === 'memory' ? createMemoryStore(options)
      : createSqliteStore(path.join(root, label+'.db'), options);
    try {
      for (const event of events) assert.equal(store.ingest(event), true);
      assert.deepEqual(store.read('cmp-local-order'), events);
      const result = await read(store, root);
      assert.equal(JSON.stringify(events), input);
      assert.deepEqual(env(), before); assert.equal(process.cwd(), cwd);
      return result;
    } finally { store.close(); }
  };
}
function inspect(store) {
  const events = store.read('cmp-local-order'), view = getCampaign(store, 'cmp-local-order');
  assert.deepEqual(view, fold(events));
  const rsi = summarizeStoreRsi(store), next = selectNextCampaigns(store, rsi);
  assert.deepEqual(selectNextCampaigns(store), next);
  const ranked = rankCampaignMembers(view, rsi, events), legacy = rankCampaignMembers(view, rsi);
  assert.deepEqual(store.read('cmp-local-order'), events);
  return { view, rsi, next, ranked, legacy };
}
const recovering = rows => rows.find(r => r.member === 'recovering-worker');

test('completion order keeps a recovered worker available in both real selectors', async t => {
  const use = ownedStores(t), results = [];
  for (const kind of ['memory', 'sqlite']) {
    const reports = [];
    for (const [i, events] of pair().entries()) reports.push(await use(kind, events, kind+'-'+i, inspect));
    results.push({ kind, reports });
  }
  t.diagnostic(JSON.stringify(results.map(({ kind, reports }) => ({ kind, facts:reports.map(r => ({
    overall:r.rsi.members[0].overall, rank:r.ranked, next:r.next })) }))));
  assert.deepEqual(results[1].reports, results[0].reports, 'complete adapter views, summaries and routing agree');
  for (const { reports:[normal, swapped] } of results) {
    assert.deepEqual(normal.rsi, swapped.rsi, 'the complete RSI report is unchanged');
    assert.deepEqual(normal.view.missions.map(m => m.id), ['m-f1','m-f2','m-k']);
    assert.deepEqual(swapped.view.missions.map(m => m.id), ['m-k','m-f2','m-f1']);
    for (const mission of normal.view.missions) assert.deepEqual(swapped.view.missions.find(m => m.id === mission.id), mission);
    const { missions:one, ...normalRest } = normal.view, { missions:two, ...swappedRest } = swapped.view;
    assert.deepEqual(normalRest, swappedRest);
    assert.deepEqual([recovering(normal.legacy).consecutiveFailures, recovering(swapped.legacy).consecutiveFailures], [0,2]);
    assert.deepEqual([recovering(normal.legacy).benched, recovering(swapped.legacy).benched], [false,true]);
    assert.equal(normal.rsi.members[0].overall, 83); assert.equal(normal.rsi.members[0].reward, 0.2);
    for (const report of [normal, swapped]) {
      assert.equal(recovering(report.ranked).consecutiveFailures, 0);
      assert.equal(recovering(report.ranked).benched, false);
      assert.equal(report.next[0].lead_member, 'recovering-worker');
      assert.equal(report.next[0].lead_overall, 83);
      assert.deepEqual(report.next[0].benched_members, []);
    }
  }
});

test('real proposal routing retains the recovered assignee without comparing tried-list order', async t => {
  const use = ownedStores(t), results = [];
  for (const kind of ['memory', 'sqlite']) for (const [i, events] of pair().entries()) {
    const result = await use(kind, events, 'plan-'+kind+'-'+i, async (store, root) => {
      let prompt, asks = 0;
      const loop = makeLoop(root, {}, { store, log:() => {}, ask:async (_root, _view, text) => {
        prompt = text; asks++;
        return { text:JSON.stringify([{ objective:'Check the recovered result', member:'recovering-worker', verify:'false', estimate_usd:0.1 }]), engine:'local-test', ok:true };
      } });
      const proposals = await loop.propose('cmp-local-order', 1), stored = store.read('cmp-local-order');
      assert.equal(asks, 1); assert.deepEqual(stored.slice(0, events.length), events);
      const added = stored.slice(events.length);
      assert.deepEqual(added.map(e => e.type), ['mission_proposed','mission_claimed','step']);
      const id = added[0].data.mission_id;
      assert.ok(added.every(e => e.data.mission_id === id));
      assert.equal(added[2].data.kind, 'plan'); assert.equal(added[2].data.engine, 'local-test');
      assert.equal(added[2].actor, 'recovering-worker');
      const mission = getCampaign(store, 'cmp-local-order').missions.find(m => m.id === id);
      return { kind, variant:i, proposals, added, mission,
        memberLine:prompt.split('\n').find(line => line.startsWith('Members who can take a mission:')),
        watchout:prompt.split('\n').find(line => line.startsWith('Seat watchouts:')) };
    });
    results.push(result);
  }
  t.diagnostic(JSON.stringify(results.map(r => ({ kind:r.kind, variant:r.variant, memberLine:r.memberLine,
    watchout:r.watchout, proposed:r.proposals[0].member, actualMember:r.mission.member }))));
  for (const result of results) {
    assert.match(result.memberLine, /recovering-worker \(83 ovr/);
    assert.ok(!result.memberLine.includes('benched'));
    assert.equal(result.watchout, undefined);
    assert.equal(result.proposals[0].member, 'recovering-worker');
    assert.equal(result.added[0].data.member, 'recovering-worker');
    assert.deepEqual(result.added.slice(0, 2).map(e => e.actor), ['recovering-worker','recovering-worker']);
    assert.equal(result.mission.member, 'recovering-worker'); assert.equal(result.mission.status, 'claimed');
    assert.equal(result.mission.steps, 1);
  }
  assert.ok(results.every(r => r.memberLine === results[0].memberLine));
});

function ended(events, id, mission_id, at, outcome = 'failed') {
  return { id, campaign_id:'cmp-local-order', type:'mission_ended', at,
    origin:'owned-extra', seq:events.length+1, actor:'recovering-worker', data:{ mission_id, outcome, cost_usd:0 } };
}

test('effective last ends, canonical ties and retained credit remain the streak boundaries', t => {
  const base = pair()[0];
  const last = base.concat(ended(base, 'later-f1', 'm-f1', '2026-10-17T00:00:14Z'));
  last.push(ended(last, 'later-f2', 'm-f2', '2026-10-17T00:00:15Z'));
  const kept = last.concat(ended(last, 'later-kept', 'm-f1', '2026-10-17T00:00:16Z', 'kept'));
  const firstId = base.concat({ ...ended(base, 'local-order-3', 'm-f1', '2026-10-17T00:00:14Z') });
  const replay = base.concat(structuredClone(base[7]));
  const nanos = pair()[1];
  nanos[7].at = '2026-10-17T00:00:10.000000001Z';
  nanos[8].at = '2026-10-17T00:00:10.000000002Z';
  nanos[9].at = '2026-10-16T17:00:10.000000003-07:00';
  const tied = pair()[1];
  for (const [index, seq] of [[7,2],[8,10],[9,3]]) {
    tied[index].at = '2026-10-17T00:00:10Z'; tied[index].origin = 'tie'; tied[index].seq = seq;
  }
  const credited = structuredClone(base);
  credited[9].data.outcome = 'failed'; credited[10].data.passed = true;
  credited.push({ id:'worked', campaign_id:'cmp-local-order', type:'step', at:'2026-10-17T00:00:07Z',
    origin:'work', seq:1, actor:'recovering-worker', data:{ mission_id:'m-k', cost_usd:0 } });
  credited.push(ended(credited, 'still-credited', 'm-k', '2026-10-17T00:00:14Z'));
  const cases = [['last-end',last,2], ['later-kept',kept,0], ['non-end-first-ID',firstId,0],
    ['replay',replay,0], ['nanoseconds',nanos,0], ['numeric-tie',tied,1], ['final-credit',credited,0]];
  const actual = cases.map(([name, events, expected]) => {
    const input = JSON.stringify(events); freeze(events);
    const view = fold(events), summary = summarizeTrace(events);
    assert.equal(view.error, undefined); assert.equal(summary.error, undefined);
    const rank = recovering(rankCampaignMembers(view, summary, events));
    assert.equal(JSON.stringify(events), input);
    if (name === 'final-credit') assert.equal(view.missions.find(m => m.id === 'm-k').credited, true);
    assert.equal(view.budget.spent, 0);
    return { name, expected, actual:rank.consecutiveFailures };
  });
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual.map(r => r.actual), actual.map(r => r.expected));
});

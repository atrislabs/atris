'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateEvent } = require('../lib/campaign-schema');
const { createMemoryStore, createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { buildTrace } = require('../lib/campaign-trace');
const { summarizeTrace, summarizeStoreRsi, selectNextCampaigns } = require('../lib/campaign-rsi');
const { rankCampaignMembers } = require('../lib/campaign-loop');

function builder(prefix, origin) {
  const events = [];
  const add = (campaign_id, type, data, actor = 'owner') => {
    const seq = events.length + 1;
    events.push({ id:prefix+'-'+String(seq).padStart(2, '0'), campaign_id, type,
      at:'2026-10-17T00:00:'+String(seq).padStart(2, '0')+'Z', origin, seq, actor, data });
  };
  return { events, add };
}
function baselineFixture() {
  const { events, add } = builder('missing-baseline-next', 'owned-missing-baseline');
  add('cmp-no-before', 'campaign_started', { title:'Five jobs before the first measurement', owner:'baseline-free-worker', judge:'false', budget:10 });
  for (let i = 1; i <= 5; i++) {
    const mission_id = 'm-no-before-'+i;
    add('cmp-no-before', 'mission_started', { mission_id, member:'baseline-free-worker' }, 'baseline-free-worker');
    add('cmp-no-before', 'mission_ended', { mission_id, outcome:'kept', cost_usd:0 }, 'baseline-free-worker');
  }
  add('cmp-no-before', 'judge_ran', { passed:true, reading:1 }, 'judge');
  add('cmp-measured', 'campaign_started', { title:'One job with measured progress', owner:'measured-worker', judge:'false', budget:10 });
  add('cmp-measured', 'judge_ran', { passed:false, reading:0 }, 'judge');
  add('cmp-measured', 'mission_started', { mission_id:'m-measured-1', member:'measured-worker' }, 'measured-worker');
  add('cmp-measured', 'mission_ended', { mission_id:'m-measured-1', outcome:'kept', cost_usd:0 }, 'measured-worker');
  add('cmp-measured', 'judge_ran', { passed:false, reading:0.2 }, 'judge');
  add('cmp-next', 'campaign_started', { title:'Choose the next worker from measured evidence', owner:'chooser', judge:'false', budget:10 });
  add('cmp-next', 'judge_ran', { passed:false, reading:0 }, 'judge');
  for (const member of ['baseline-free-worker', 'measured-worker']) add('cmp-next', 'seat_filled', { member, role:'cli' });
  return events;
}
function controlFixture(after) {
  const id = after === null ? 'cmp-missing-after' : 'cmp-comparable';
  const { events, add } = builder(id, id);
  add(id, 'campaign_started', { title:id, owner:'control-worker', judge:'false', budget:10 });
  add(id, 'judge_ran', { passed:false, reading:0 }, 'judge');
  add(id, 'mission_started', { mission_id:id+'-job', member:'control-worker' }, 'control-worker');
  add(id, 'mission_ended', { mission_id:id+'-job', outcome:'kept', cost_usd:0 }, 'control-worker');
  if (after !== null) add(id, 'judge_ran', { passed:true, reading:after }, 'judge');
  return events;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function readBoth(t, events) {
  const key = crypto.randomBytes(32), cwd = process.cwd();
  const env = () => Object.fromEntries(Object.keys(process.env).sort().map(k => [k, crypto.createHmac('sha256', key).update(process.env[k]).digest('hex')]));
  const caller = env(), input = JSON.stringify(events);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbl-')), marker = path.join(root, 'foreign');
  t.after(() => {
    try { assert.equal(fs.readFileSync(marker, 'utf8'), 'retain'); }
    finally { fs.rmSync(root, { recursive:true, force:true }); }
    assert.deepEqual(env(), caller); assert.equal(process.cwd(), cwd);
  });
  fs.writeFileSync(marker, 'retain'); freeze(events);
  const read = kind => {
    const store = kind === 'memory' ? createMemoryStore({ origin:'owned-reader' })
      : createSqliteStore(path.join(root, 'state', 'campaign.db'), { origin:'owned-reader' });
    try {
      for (const event of events) {
        assert.equal(validateEvent(event).ok, true, event.id);
        assert.equal(store.ingest(event), true);
      }
      const ids = store.campaignIds(), stored = ids.map(id => store.read(id));
      assert.equal(JSON.stringify(stored.flat()), input);
      const campaigns = stored.map(rows => ({ trace:buildTrace(rows, { redact:false }), summary:summarizeTrace(rows) }));
      const rsi = summarizeStoreRsi(store), next = selectNextCampaigns(store, rsi);
      assert.deepEqual(selectNextCampaigns(store), next, 'implicit summary uses the same actual supplied store');
      assert.deepEqual(rsi.campaigns, campaigns.map(c => c.summary));
      const view = ids.includes('cmp-next') ? getCampaign(store, 'cmp-next') : null;
      const ranked = view ? rankCampaignMembers(view, rsi) : [];
      assert.deepEqual(ids.map(id => store.read(id)), stored);
      return { campaigns, rsi, next, ranked };
    } finally { store.close(); }
  };
  const reports = [read('memory'), read('sqlite')];
  assert.deepEqual(reports[1], reports[0], 'complete real adapter summaries, traces, ranks and selections agree');
  assert.equal(JSON.stringify(events), input);
  assert.deepEqual(env(), caller); assert.equal(process.cwd(), cwd);
  return reports;
}

test('a real later pass without an earlier measurement cannot outrank measured improvement', t => {
  const events = baselineFixture();
  assert.equal(events.length, 21);
  const reports = readBoth(t, events);
  t.diagnostic(JSON.stringify(reports.map((r, i) => ({ adapter:i === 0 ? 'memory' : 'sqlite',
    members:r.rsi.members.map(m => ({ member:m.member, overall:m.overall, status:m.status, proof:m.judge_passed, reward:m.reward })),
    next:r.next.find(c => c.id === 'cmp-next'), ranked:r.ranked }))));
  for (const report of reports) {
    const noBefore = report.campaigns.find(c => c.summary.campaign_id === 'cmp-no-before');
    const measured = report.campaigns.find(c => c.summary.campaign_id === 'cmp-measured');
    assert.equal(noBefore.trace.header.final.state, 'done');
    assert.equal(noBefore.trace.header.final.stop_reason, 'judge_passed');
    assert.equal(noBefore.trace.header.final.reading, 1);
    assert.equal(noBefore.trace.rows.length, 5);
    assert.deepEqual(noBefore.trace.rows.map(r => [r.reading_before, r.reading_after, r.reward, r.judge_passed, r.done, r.outcome, r.cost_usd]),
      Array.from({ length:5 }, () => [null, 1, null, true, true, 'kept', 0]));
    assert.ok(noBefore.trace.rows.every(r => /no judge run before/.test(r.credit_note)));
    assert.deepEqual(noBefore.summary.missions.map(m => [m.reading_before, m.reading_after, m.reward, m.outcome, m.cost_usd]),
      Array.from({ length:5 }, () => [null, 1, null, 'kept', 0]));
    assert.deepEqual(measured.trace.rows.map(r => [r.reading_before, r.reading_after, r.reward, r.judge_passed, r.done]), [[0, 0.2, 0.2, false, false]]);
    const effective = report.rsi.members.find(m => m.member === 'measured-worker');
    assert.equal(effective.overall, 89); assert.equal(effective.judge_passed, 1);
    assert.equal(effective.reward, 0.2); assert.equal(report.rsi.total_reward, 0.2);
    assert.equal(report.rsi.total_spent_usd, 0); assert.equal(report.rsi.missions.length, 6);
    const direct = noBefore.summary.members[0];
    const global = report.rsi.members.find(m => m.member === 'baseline-free-worker');
    assert.equal(global.missions, 5); assert.equal(global.kept, 5); assert.equal(global.reward, 0);
    assert.deepEqual({ proof:[direct, global].map(m => ({ proof:m.judge_passed, status:m.status, overall:m.overall })),
      lead:report.next.find(c => c.id === 'cmp-next').lead_member, ranked:report.ranked[0].member },
    { proof:[{ proof:0, status:'unproven', overall:75 }, { proof:0, status:'unproven', overall:75 }],
      lead:'measured-worker', ranked:'measured-worker' });
    assert.match(global.note, /no judge progress/);
  }
});

test('a comparable zero-to-one pass still proves the actual kept work', t => {
  for (const report of readBoth(t, controlFixture(1))) {
    const { trace, summary } = report.campaigns[0];
    assert.deepEqual(trace.rows.map(r => [r.reading_before, r.reading_after, r.reward, r.judge_passed, r.done]), [[0, 1, 1, true, true]]);
    assert.equal(trace.header.final.stop_reason, 'judge_passed');
    assert.deepEqual([summary.members[0].judge_passed, summary.members[0].status, summary.members[0].overall, summary.members[0].reward], [1, 'proving', 89, 1]);
    assert.deepEqual(report.rsi.members, summary.members);
  }
});

test('an absent later measurement remains unproven', t => {
  for (const report of readBoth(t, controlFixture(null))) {
    const { trace, summary } = report.campaigns[0];
    assert.deepEqual(trace.rows.map(r => [r.reading_before, r.reading_after, r.reward, r.judge_passed, r.done]), [[0, null, null, null, false]]);
    assert.equal(trace.header.final.state, 'resting');
    assert.deepEqual([summary.members[0].judge_passed, summary.members[0].status, summary.members[0].overall, summary.members[0].reward], [0, 'unproven', 75, 0]);
    assert.deepEqual(report.rsi.members, summary.members);
  }
});

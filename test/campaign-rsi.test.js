'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeMemberOverall,
  formatRsiReport,
  missionRewardMap,
  summarizeStoreRsi,
  summarizeTrace,
  writeRsiSnapshot,
} = require('../lib/campaign-rsi');
const { readLessons } = require('../lib/campaign-cadence');
const { createMemoryStore } = require('../lib/campaign-store');

function makeEvents(campaignId = 'cmp-rsi', title = 'Improve campaign loop') {
  let seq = 0;
  const ev = (type, minute, data, actor = 'builder') => {
    seq += 1;
    return {
      id: `${campaignId}-evt-${String(seq).padStart(3, '0')}`,
      campaign_id: campaignId,
      type,
      at: `2026-10-15T10:${String(minute).padStart(2, '0')}:00Z`,
      origin: 'laptop',
      seq,
      actor,
      data,
    };
  };

  return [
    ev('campaign_started', 0, {
      title,
      judge: 'node --test test/campaign.test.js',
      budget: 10,
      owner: 'mission-lead',
      seats: ['builder', 'validator'],
    }, 'human:keshav'),
    ev('judge_ran', 1, { passed: false, summary: 'pass 1, fail 3', reading: 0.25 }, 'judge'),
    ev('mission_proposed', 2, {
      mission_id: 'm-1',
      member: 'builder',
      objective: 'wire trace reward into campaign summary',
      verify: 'node --test test/campaign-rsi.test.js',
      estimate_usd: 0.5,
    }),
    ev('mission_started', 3, { mission_id: 'm-1', member: 'builder', engine: 'claude' }),
    ev('step', 4, { mission_id: 'm-1', cost_usd: 0.5 }),
    ev('mission_ended', 5, { mission_id: 'm-1', outcome: 'kept', cost_usd: 0.5 }),
    ev('judge_ran', 6, { passed: false, summary: 'pass 3, fail 1', reading: 0.75 }, 'judge'),
    ev('mission_started', 7, { mission_id: 'm-2', member: 'validator', objective: 'refactor unrelated helper' }, 'validator'),
    ev('step', 8, { mission_id: 'm-2', cost_usd: 0.25 }, 'validator'),
    ev('mission_ended', 9, { mission_id: 'm-2', outcome: 'kept', cost_usd: 0.25 }, 'validator'),
    ev('judge_ran', 10, { passed: false, summary: 'pass 3, fail 1', reading: 0.75 }, 'judge'),
    ev('mission_started', 11, { mission_id: 'm-3', member: 'validator', objective: 'broad rewrite' }, 'validator'),
    ev('mission_ended', 12, { mission_id: 'm-3', outcome: 'failed', cost_usd: 0.25 }, 'validator'),
    ev('judge_ran', 13, { passed: false, summary: 'pass 3, fail 1', reading: 0.75 }, 'judge'),
    ev('mission_started', 14, { mission_id: 'm-4', member: 'builder', objective: 'feed lessons back into cadence' }),
    ev('step', 15, { mission_id: 'm-4', cost_usd: 0.5 }),
    ev('mission_ended', 16, { mission_id: 'm-4', outcome: 'kept', cost_usd: 0.5 }),
    ev('judge_ran', 17, { passed: true, summary: 'pass 4, fail 0', reading: 1 }, 'judge'),
  ];
}

test('summarizeTrace computes mission rewards, member stats, and deterministic lessons', () => {
  assert.ok(summarizeTrace([]).error);

  const summary = summarizeTrace(makeEvents());
  assert.equal(summary.error, undefined);
  assert.equal(summary.campaign_id, 'cmp-rsi');
  assert.equal(summary.title, 'Improve campaign loop');
  assert.equal(summary.state, 'done');
  assert.equal(summary.reading, 1);
  assert.equal(summary.spent_usd, 1.5);
  assert.equal(summary.total_reward, 0.75);
  assert.equal(summary.reward_per_dollar, 0.5);
  assert.equal(summary.missions.length, 4);

  assert.deepEqual(
    summary.members.map((m) => ({
      member: m.member,
      missions: m.missions,
      kept: m.kept,
      failed: m.failed,
      reward: m.reward,
      cost_usd: m.cost_usd,
      reward_per_dollar: m.reward_per_dollar,
      zero_reward_kept: m.zero_reward_kept,
    })),
    [
      {
        member: 'builder',
        missions: 2,
        kept: 2,
        failed: 0,
        reward: 0.75,
        cost_usd: 1,
        reward_per_dollar: 0.75,
        zero_reward_kept: 0,
      },
      {
        member: 'validator',
        missions: 2,
        kept: 1,
        failed: 1,
        reward: 0,
        cost_usd: 0.5,
        reward_per_dollar: 0,
        zero_reward_kept: 1,
      },
    ]
  );

  assert.ok(summary.lessons.every((l) => l.startsWith('- ')));
  assert.ok(summary.lessons.some((l) => l.includes('builder gained +0.5 reading (0.25 to 0.75) for $0.50 on cmp-rsi: wire trace reward into campaign summary')));
  assert.ok(summary.lessons.some((l) => l.includes('validator finished m-2 on cmp-rsi with no reading gain; tie verify directly to a failing judge check')));
  assert.ok(summary.lessons.some((l) => l.includes('validator had m-3 end failed on cmp-rsi; keep scope to one checkable slice')));
  assert.ok(summary.lessons.some((l) => l.includes('top member by reading gain: builder (+0.75 reading across 2/2 kept, $1.00 spent)')));
  for (const lesson of summary.lessons) {
    assert.doesNotMatch(lesson, /\u2014/);
  }
});

test('summarizeStoreRsi aggregates across campaigns and filters by campaignId', () => {
  const store = createMemoryStore({ origin: 'laptop' });
  for (const ev of makeEvents('cmp-one', 'First campaign')) store.ingest(ev);

  store.append({
    campaign_id: 'cmp-two',
    type: 'campaign_started',
    actor: 'mission-lead',
    data: { title: 'Second campaign', judge: 'npm test', budget: 5, owner: 'mission-lead', seats: ['builder'] },
  });
  store.append({ campaign_id: 'cmp-two', type: 'judge_ran', actor: 'judge', data: { passed: false, reading: 0.1 } });
  store.append({ campaign_id: 'cmp-two', type: 'mission_started', actor: 'builder', data: { mission_id: 'm-20', member: 'builder', objective: 'add rsi cli verb' } });
  store.append({ campaign_id: 'cmp-two', type: 'mission_ended', actor: 'builder', data: { mission_id: 'm-20', outcome: 'kept', cost_usd: 0.5 } });
  store.append({ campaign_id: 'cmp-two', type: 'judge_ran', actor: 'judge', data: { passed: false, reading: 0.6 } });

  const all = summarizeStoreRsi(store);
  assert.equal(all.campaigns_count, 2);
  assert.equal(all.completed_count, 1);
  assert.equal(all.total_reward, 1.25);
  assert.equal(all.total_spent_usd, 2);
  assert.equal(all.reward_per_dollar, 0.625);
  assert.equal(all.missions.length, 5);
  assert.equal(all.members[0].member, 'builder');
  assert.equal(all.members[0].reward, 1.25);
  assert.equal(all.members[0].kept, 3);

  const single = summarizeStoreRsi(store, 'cmp-two');
  assert.equal(single.campaigns_count, 1);
  assert.equal(single.completed_count, 0);
  assert.equal(single.total_reward, 0.5);
  assert.equal(single.total_spent_usd, 0.5);
  assert.equal(single.reward_per_dollar, 1);
});

test('writeRsiSnapshot persists state json and deduplicated lessons for cadence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rsi-'));
  try {
    const store = createMemoryStore({ origin: 'laptop' });
    for (const ev of makeEvents('cmp-rsi', 'Improve campaign loop')) store.ingest(ev);

    const rsi = writeRsiSnapshot(root, store, 'cmp-rsi');
    assert.equal(rsi.campaigns_count, 1);

    const statePath = path.join(root, '.atris', 'state', 'campaign-rsi.json');
    assert.equal(fs.existsSync(statePath), true);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(saved.updated_at);
    assert.equal(saved.total_reward, 0.75);

    const globalLessons = fs.readFileSync(path.join(root, 'atris', 'campaigns', 'lessons.md'), 'utf8');
    assert.match(globalLessons, /# Campaign RSI Lessons/);
    assert.match(globalLessons, /builder gained \+0\.5 reading/);

    const cadenceLessons = readLessons(root, 'cmp-rsi');
    assert.match(cadenceLessons, /builder gained \+0\.5 reading/);
    assert.match(cadenceLessons, /top member by reading gain: builder/);

    // Second write does not duplicate lessons.
    writeRsiSnapshot(root, store, 'cmp-rsi');
    const afterSecond = readLessons(root, 'cmp-rsi');
    assert.equal(afterSecond, cadenceLessons);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formatRsiReport and missionRewardMap produce clean plain-language output and lookup map', () => {
  const events = makeEvents('cmp-rsi', 'Improve campaign loop');
  const store = createMemoryStore({ origin: 'laptop' });
  for (const ev of events) store.ingest(ev);

  const rsi = summarizeStoreRsi(store);
  const report = formatRsiReport(rsi);
  assert.match(report, /^campaign rsi: 1 campaign \(1 done\) · \+0\.75 reading · \$1\.50 spent$/m);
  assert.doesNotMatch(report, /reading\/\$/);
  assert.match(report, /members:\n  builder\s+\d+ ovr · \+0\.75 reading · 2\/2 kept · \$1\.00/);
  assert.match(report, /lessons:\n  - builder gained \+0\.5 reading/);
  assert.doesNotMatch(report, /\u2014/);

  const elite = computeMemberOverall({ missions: 5, kept: 5, reverted: 0, judgePassed: 3, repeatFailures: 0, costUsd: 1.5, wastedCostUsd: 0 });
  const unproven = computeMemberOverall({ missions: 1, kept: 1, reverted: 0, judgePassed: 1, repeatFailures: 0, costUsd: 0.3, wastedCostUsd: 0 });
  const thrashing = computeMemberOverall({ missions: 26, kept: 11, reverted: 0, judgePassed: 0, repeatFailures: 14, costUsd: 21.34, wastedCostUsd: 12.5 });
  assert.ok(elite.overall >= 90 && elite.overall <= 99);
  assert.ok(unproven.overall <= 89);
  assert.ok(thrashing.overall < 70);

  const rewards = missionRewardMap(events);
  assert.equal(rewards instanceof Map, true);
  assert.deepEqual(rewards.get('m-1'), { reward: 0.5, reading_before: 0.25, reading_after: 0.75 });
  assert.deepEqual(rewards.get('m-2'), { reward: 0, reading_before: 0.75, reading_after: 0.75 });
  assert.deepEqual(rewards.get('m-4'), { reward: 0.25, reading_before: 0.75, reading_after: 1 });
  assert.equal(missionRewardMap([]).size, 0);
});

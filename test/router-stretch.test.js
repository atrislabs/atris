'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRETCH_ZONE_MIN,
  STRETCH_ZONE_MAX,
  rankEnginesDetailed,
  routerPickExplanation,
  stretchZonePick,
} = require('../lib/router-brain');

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

function observationsFor(engine, taskType, passes, total) {
  const rows = [];
  for (let index = 0; index < total; index += 1) {
    rows.push({
      engine,
      task_type: taskType,
      verified_passed: index < passes,
      duration_ms: 500,
      at_ms: NOW - index,
    });
  }
  return rows;
}

function candidates() {
  return [
    { id: 'cheap', fallback_order: 10, cost: 1 },
    { id: 'mid', fallback_order: 20, cost: 5 },
    { id: 'strong', fallback_order: 30, cost: 20 },
  ];
}

test('stretch zone band constants match the routing rule', () => {
  assert.equal(STRETCH_ZONE_MIN, 0.6);
  assert.equal(STRETCH_ZONE_MAX, 0.85);
});

test('pure pick lands the cheapest engine inside the band', () => {
  const entries = [
    { candidate: { id: 'strong', cost: 20 }, predicted: 0.95 },
    { candidate: { id: 'mid', cost: 5 }, predicted: 0.8 },
    { candidate: { id: 'cheap', cost: 1 }, predicted: 0.7 },
  ];
  assert.equal(stretchZonePick(entries, { lowStakes: true }).id, 'cheap');
  assert.equal(stretchZonePick(entries, { stakes: 'low' }).id, 'cheap');
});

test('pure pick prefers the cheaper of two in-band engines', () => {
  const entries = [
    { candidate: { id: 'pricey-band', cost: 9 }, predicted: 0.84 },
    { candidate: { id: 'cheap-band', cost: 2 }, predicted: 0.62 },
  ];
  assert.equal(stretchZonePick(entries, { lowStakes: true }).id, 'cheap-band');
});

test('pure pick returns null when every engine sits below the band floor', () => {
  const entries = [
    { candidate: { id: 'cheap', cost: 1 }, predicted: 0.4 },
    { candidate: { id: 'strong', cost: 20 }, predicted: 0.55 },
  ];
  assert.equal(stretchZonePick(entries, { lowStakes: true }), null);
});

test('pure pick ignores lanes that are not low stakes', () => {
  const entries = [{ candidate: { id: 'cheap', cost: 1 }, predicted: 0.7 }];
  assert.equal(stretchZonePick(entries, {}), null);
  assert.equal(stretchZonePick(entries, { stakes: 'high' }), null);
  assert.equal(stretchZonePick(entries), null);
});

test('pure pick treats engines above the band as out of zone and missing cost as most expensive', () => {
  const onlyTooEasy = [
    { candidate: { id: 'strong', cost: 20 }, predicted: 0.9 },
    { candidate: { id: 'cheap', cost: 1 }, predicted: 0.95 },
  ];
  assert.equal(stretchZonePick(onlyTooEasy, { lowStakes: true }), null);

  const noCost = [
    { candidate: { id: 'no-cost' }, predicted: 0.99 },
    { candidate: { id: 'priced', cost: 50 }, predicted: 0.65 },
    { candidate: { id: 'no-cost-band' }, predicted: 0.7 },
  ];
  assert.equal(stretchZonePick(noCost, { lowStakes: true }).id, 'priced');
});

test('low-stakes lane routing prefers the cheapest in-band engine over the strongest', () => {
  const observations = [
    ...observationsFor('cheap', 'chore', 7, 10),
    ...observationsFor('mid', 'chore', 8, 10),
    ...observationsFor('strong', 'chore', 10, 10),
  ];
  const decision = rankEnginesDetailed(candidates(), {
    observations,
    taskType: 'chore',
    now: NOW,
    lowStakes: true,
  });
  assert.equal(decision.used_track_record, true);
  assert.equal(decision.candidates[0].id, 'cheap');
  assert.equal(decision.stretch_zone_pick, 'cheap');
  // after the stretch pick, the rest keep normal score order.
  assert.deepEqual(decision.candidates.map((row) => row.id), ['cheap', 'strong', 'mid']);
});

test('low-stakes lane escalates to the strongest engine when everyone is below the floor', () => {
  const observations = [
    ...observationsFor('cheap', 'chore', 4, 10),
    ...observationsFor('mid', 'chore', 5, 10),
    ...observationsFor('strong', 'chore', 11, 20),
  ];
  const decision = rankEnginesDetailed(candidates(), {
    observations,
    taskType: 'chore',
    now: NOW,
    lowStakes: true,
  });
  assert.equal(decision.candidates[0].id, 'strong');
  assert.equal(decision.stretch_zone_pick, null);
});

test('lanes without the low-stakes flag keep the strongest first', () => {
  const observations = [
    ...observationsFor('cheap', 'chore', 7, 10),
    ...observationsFor('mid', 'chore', 8, 10),
    ...observationsFor('strong', 'chore', 10, 10),
  ];
  const decision = rankEnginesDetailed(candidates(), {
    observations,
    taskType: 'chore',
    now: NOW,
  });
  assert.equal(decision.candidates[0].id, 'strong');
  assert.equal(decision.stretch_zone_pick, null);
});

test('explanation names the stretch zone when the rule wins', () => {
  const observations = [
    ...observationsFor('cheap', 'chore', 7, 10),
    ...observationsFor('mid', 'chore', 8, 10),
    ...observationsFor('strong', 'chore', 10, 10),
  ];
  const decision = rankEnginesDetailed(candidates(), {
    observations,
    taskType: 'chore',
    now: NOW,
    lowStakes: true,
  });
  const line = routerPickExplanation(decision);
  assert.equal(line, line.toLowerCase());
  assert.match(line, /^router picked cheap because the lane is low stakes .*\.$/);
  assert.match(line, /stretch zone/);
});

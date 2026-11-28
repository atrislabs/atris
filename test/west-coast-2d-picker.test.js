'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EFFORT_COST_PENALTY,
  computeEngineEffortStats,
  rankEngineEffortArms,
  loadRouterHistory,
} = require('../lib/router-brain');
const {
  LEGACY_EFFORT_WEIGHT,
  parseArmKey,
  formatArmKey,
  pickBuilderArms,
  pickBuilders,
} = require('../lib/builder-pick');

const NOW = Date.parse('2026-11-20T00:00:00Z');
const START = Date.parse('2026-11-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function obs(engine, effort, passed, extra = {}) {
  return { engine, task_type: 'executor', verified_passed: passed, duration_ms: 60000, at_ms: NOW - HOUR, ...(effort ? { effort } : {}), ...extra };
}
const many = (n, ...args) => Array.from({ length: n }, () => obs(...args));

let seq = 0;
function play(member, kind, extra = {}) {
  seq += 1;
  return { member, kind, claimed_at: START + HOUR, task_id: `p-${seq}`, lane: [], ...extra };
}
const plays = (n, member, kind, extra) => Array.from({ length: n }, () => play(member, kind, extra));

test('effort stats keep low and high apart and read effort from roster runs', () => {
  const stats = computeEngineEffortStats([...many(3, 'claude', 'low', true), ...many(3, 'claude', 'high', false), obs('claude', null, true)], { now: NOW });
  const low = stats.find((r) => r.effort === 'low');
  const high = stats.find((r) => r.effort === 'high');
  const plain = stats.find((r) => r.effort === 'default');
  assert.equal(low.verified_passes, 3);
  assert.equal(high.verified_failures, 3);
  assert.equal(plain.receipt_count, 1);
  assert.equal(low.cost_adjusted_score, low.recency_weighted_score - EFFORT_COST_PENALTY.low);
  assert.deepEqual(stats.map((r) => r.effort), ['default', 'high', 'low']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc2d-'));
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    const at = new Date(NOW - HOUR).toISOString();
    const rows = [
      { at, job: 'build', engine: 'claude', effort: 'low', outcome: 'landed', seconds: 30, task: 't1' },
      { at, job: 'build', engine: 'claude', effort: 'high', outcome: 'failed', seconds: 90, task: 't2' },
      { at, job: 'build', engine: 'codex', outcome: 'landed', seconds: 40, task: 't3' },
    ];
    fs.writeFileSync(path.join(root, '.atris', 'state', 'roster_runs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const history = loadRouterHistory(root, { now: NOW });
    const byTask = Object.fromEntries(history.map((h) => [h.engine + (h.effort || ''), h]));
    assert.equal(byTask.claudelow.verified_passed, true);
    assert.equal(byTask.claudehigh.verified_passed, false);
    assert.equal('effort' in byTask.codex, false);
    const s = computeEngineEffortStats(history, { now: NOW });
    assert.ok(s.find((r) => r.engine === 'claude' && r.effort === 'low'));
    assert.ok(s.find((r) => r.engine === 'claude' && r.effort === 'high'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('arm ranking favors low effort on ties, high when it is clearly better, and falls back when thin', () => {
  const arms = [{ engine: 'claude', effort: 'high' }, 'claude@low'];
  const tie = rankEngineEffortArms(arms, { taskType: 'executor', now: NOW, observations: [...many(4, 'claude', 'low', true), ...many(4, 'claude', 'high', true)] });
  assert.equal(tie.used_track_record, true);
  assert.equal(tie.arms[0], 'claude@low');

  const better = rankEngineEffortArms(arms, {
    taskType: 'executor', now: NOW,
    observations: [...many(1, 'claude', 'low', true), ...many(4, 'claude', 'low', false), ...many(5, 'claude', 'high', true)],
  });
  assert.equal(better.used_track_record, true);
  assert.deepEqual(better.arms[0], { engine: 'claude', effort: 'high' });

  const thin = rankEngineEffortArms(arms, { taskType: 'executor', now: NOW, observations: [...many(4, 'claude', 'low', true), ...many(2, 'claude', 'high', true)] });
  assert.equal(thin.used_track_record, false);
  assert.deepEqual(thin.arms, arms);
  assert.deepEqual(thin.thin_arms, ['claude@high']);

  const noType = rankEngineEffortArms(arms, { now: NOW, observations: [] });
  assert.equal(noType.used_track_record, false);
});

test('arm keys parse strings, engine@effort and objects', () => {
  assert.deepEqual(parseArmKey('claude'), { key: 'claude', engine: 'claude', effort: null });
  assert.deepEqual(parseArmKey(' Claude@LOW '), { key: 'claude@low', engine: 'claude', effort: 'low' });
  assert.deepEqual(parseArmKey({ engine: 'Codex', effort: 'High' }), { key: 'codex@high', engine: 'codex', effort: 'high' });
  assert.deepEqual(parseArmKey({ engine: 'codex' }), { key: 'codex', engine: 'codex', effort: null });
  assert.equal(parseArmKey(''), null);
  assert.equal(parseArmKey({ effort: 'low' }), null);
  assert.equal(formatArmKey('Claude', 'Low'), 'claude@low');
  assert.equal(formatArmKey('claude'), 'claude');
});

test('a strong low arm wins over a weak high arm, and high misses do not touch low', () => {
  const history = [
    ...plays(6, 'fleet-claude', 'landed', { effort: 'low' }),
    ...plays(1, 'fleet-claude', 'landed', { effort: 'high' }),
    ...plays(5, 'fleet-claude', 'dropped', { effort: 'high' }),
  ];
  let lowWins = 0;
  for (let i = 0; i < 20; i += 1) {
    const out = pickBuilderArms({ candidates: ['claude@high', 'claude@low'], plays: history, since: START, seed: `s${i}` });
    if (out.picked === 'claude@low') lowWins += 1;
    const low = out.records.find((r) => r.key === 'claude@low');
    assert.equal(low.landed, 6);
    assert.equal(low.counted, 6);
    assert.equal(low.laneMissed + low.otherMissed, 0);
    assert.equal(low.legacyMissed, 0);
  }
  assert.ok(lowWins >= 18, `low won ${lowWins} of 20`);
  const one = pickBuilderArms({ candidates: ['claude@high', 'claude@low'], plays: history, since: START, seed: 's0' });
  assert.match(one.line, /^picked fleet-claude@(low|high) for this job: landed \d of 6 since Nov 1 \(fleet-claude@(low|high) \d of 6\)$/);
});

test('untagged plays are a soft prior and a new arm still gets tried', () => {
  assert.equal(LEGACY_EFFORT_WEIGHT, 0.25);
  const history = [
    ...plays(4, 'fleet-claude', 'landed'),
    ...plays(3, 'fleet-claude', 'dropped', { effort: 'low' }),
  ];
  const out = pickBuilderArms({ candidates: ['claude@low', 'codex@low'], plays: history, since: START, seed: 'x' });
  const low = out.records.find((r) => r.key === 'claude@low');
  assert.equal(low.legacyLanded, 4);
  assert.equal(low.counted, 3);
  assert.equal(low.landed, 0);
  // alpha 1 + 0.25*4 = 2, beta 1 + 3 = 4: the tagged misses still outweigh the soft prior.
  assert.ok(1 + LEGACY_EFFORT_WEIGHT * low.legacyLanded < 1 + low.laneMissed + low.otherMissed);

  const strong = [...plays(4, 'fleet-claude', 'landed'), ...plays(4, 'fleet-claude', 'landed', { effort: 'low' })];
  let newcomer = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = pickBuilderArms({ candidates: ['claude@low', 'codex@low'], plays: strong, since: START, seed: `n${i}` });
    if (r.picked === 'codex@low') newcomer += 1;
  }
  assert.ok(newcomer >= 1, 'codex@low never explored');
});

test('full arms are skipped and order stays the draw', () => {
  const history = plays(6, 'fleet-claude', 'landed', { effort: 'low' });
  const base = pickBuilderArms({ candidates: ['claude@low', 'codex@low'], plays: history, since: START, seed: 'f' });
  const byKey = pickBuilderArms({ candidates: ['claude@low', 'codex@low'], plays: history, since: START, seed: 'f', full: ['claude@low'] });
  const byEngine = pickBuilderArms({ candidates: ['claude@low', 'codex@low'], plays: history, since: START, seed: 'f', full: ['claude'] });
  assert.deepEqual(byKey.order, base.order);
  assert.deepEqual(byEngine.order, base.order);
  assert.equal(byKey.picked, 'codex@low');
  assert.equal(byEngine.picked, 'codex@low');
  assert.deepEqual(byEngine.pickedArm, { key: 'codex@low', engine: 'codex', effort: 'low' });
});

test('plain engine names score exactly like the old picker', () => {
  const history = [...plays(3, 'fleet-claude', 'landed'), ...plays(2, 'fleet-codex', 'dropped')];
  for (const seed of ['a', 'b', 'c']) {
    const old = pickBuilders({ candidates: ['claude', 'codex'], plays: history, since: START, seed });
    const arm = pickBuilderArms({ candidates: ['claude', 'codex'], plays: history, since: START, seed });
    assert.deepEqual(arm.order, old.order);
    assert.equal(arm.picked, old.picked);
    assert.equal(arm.line, old.line);
  }
});

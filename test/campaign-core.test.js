'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { decide, fold, paysDollars } = require('../lib/campaign-core');

const DIR = path.join(__dirname, 'fixtures', 'campaign');
const goldens = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'MANIFEST.json' && f !== 'decide-cases.json')
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const decideCases = JSON.parse(fs.readFileSync(path.join(DIR, 'decide-cases.json'), 'utf8')).cases;

for (const golden of goldens) {
  test(`golden: ${golden.name}`, () => {
    assert.deepEqual(fold(golden.events), golden.expected);
  });
}

decideCases.forEach((c, i) => {
  test(`decide ${i}: ${c.about}`, () => {
    assert.deepEqual(decide(c.view), c.expected);
  });
});

// Seeded shuffle so a failure reproduces.
function shuffled(list, seed) {
  const out = list.slice();
  let x = seed;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('every golden folds the same in any arrival order', () => {
  for (const golden of goldens) {
    if ('error' in golden.expected) continue;
    const ids = new Set();
    const unique = golden.events.filter((e) => (ids.has(e.id) ? false : ids.add(e.id)));
    for (const seed of [1, 7, 42]) {
      assert.deepEqual(fold(shuffled(unique, seed)), golden.expected, `${golden.name} seed ${seed}`);
    }
  }
});

let n = 0;
const ev = (type, data = {}, actor = 'builder') => {
  n += 1;
  return {
    id: `evt-${String(n).padStart(4, '0')}`, campaign_id: 'cmp-edge', type, origin: 'laptop', seq: n, actor, data,
    at: new Date(Date.UTC(2026, 9, 15, 10, 0, n)).toISOString(),
  };
};
const started = () => ev('campaign_started', { title: 'Edges', judge: 'exit 1', budget: 100 }, 'mission-lead');
const missionOf = (view, id) => view.missions.find((m) => m.id === id);

test('statuses only move forward, but an ended mission always counts its cost', () => {
  const view = fold([
    started(),
    ev('mission_started', { mission_id: 'm1', member: 'builder' }),
    ev('mission_claimed', { mission_id: 'm1', claim_key: 'k1' }),
    ev('mission_proposed', { mission_id: 'm1', member: 'scout', estimate_usd: 9 }),
    ev('mission_proposed', { mission_id: 'm2' }),
    ev('mission_vetoed', { mission_id: 'm2' }, 'mission-lead'),
    ev('mission_started', { mission_id: 'm2', member: 'builder' }),
    ev('mission_ended', { mission_id: 'm2', outcome: 'failed', cost_usd: 1.5 }),
  ]);
  assert.deepEqual(missionOf(view, 'm1'), { id: 'm1', member: 'builder', status: 'running', outcome: null, cost_usd: null, estimate_usd: null, steps: 0, kept: 0, reverted: 0 });
  assert.equal(missionOf(view, 'm2').status, 'ended');
  assert.equal(view.budget.spent, 1.5);
});

test('a duplicate claim on a running mission warns but does not drop it', () => {
  const view = fold([
    started(),
    ev('mission_claimed', { mission_id: 'm1', claim_key: 'same' }),
    ev('mission_started', { mission_id: 'm2', member: 'builder' }),
    ev('mission_claimed', { mission_id: 'm2', claim_key: 'same' }),
    ev('mission_claimed', { mission_id: 'm1', claim_key: 'same' }),
  ]);
  assert.equal(missionOf(view, 'm2').status, 'running');
  assert.equal(missionOf(view, 'm1').status, 'claimed');
  assert.deepEqual(view.warnings.map((w) => w.code), ['duplicate_claim']);
});

test('asks: agent check comes first, reopening an open ask is ignored', () => {
  const view = fold([
    started(),
    ev('ask_opened', { ask_id: 'a1', question: 'Spend $40 on ads?' }),
    ev('ask_opened', { ask_id: 'a1', question: 'Changed wording' }),
    ev('ask_answered', { ask_id: 'nope', answer: 'yes' }),
  ]);
  assert.deepEqual(view.asks, [{ id: 'a1', question: 'Spend $40 on ads?', mission_id: null }]);
  assert.deepEqual(view.warnings.map((w) => w.code), ['ask_answered_by_agent']);
});

test('an open ask holds only the mission it names', () => {
  const base = [
    started(),
    ev('judge_ran', { passed: false, summary: '0 of 1' }),
    ev('mission_proposed', { mission_id: 'm1', member: 'builder', estimate_usd: 1 }),
    ev('mission_claimed', { mission_id: 'm1', claim_key: 'one' }),
  ];
  const unrelated = fold([started(), ev('judge_ran', { passed: false, summary: '0 of 1' }), ev('ask_opened', { ask_id: 'a1', question: 'Pick a brand name?' })]);
  assert.equal(unrelated.state, 'needs_you');
  assert.deepEqual(decide(unrelated), { action: 'propose', reason: 'no missions queued' });
  assert.deepEqual(decide(fold([...base, ev('ask_opened', { ask_id: 'a1', question: 'Pick a name?' })])), { action: 'start_mission', mission_id: 'm1' });
  assert.deepEqual(decide(fold([...base, ev('ask_opened', { ask_id: 'a1', question: 'Spend it?', mission_id: 'm1' })])), { action: 'wait', reason: 'open asks', asks: ['a1'] });
  const two = fold([...base,
    ev('mission_proposed', { mission_id: 'm2', member: 'builder', estimate_usd: 1 }),
    ev('mission_claimed', { mission_id: 'm2', claim_key: 'two' }),
    ev('ask_opened', { ask_id: 'a1', question: 'Spend it?', mission_id: 'm1' })]);
  assert.deepEqual(decide(two), { action: 'start_mission', mission_id: 'm2' });
});

test('a reservation for an ended mission is ignored, and agent done always warns', () => {
  const view = fold([
    started(),
    ev('mission_ended', { mission_id: 'm1', outcome: 'kept', cost_usd: 3 }),
    ev('budget_reserved', { mission_id: 'm1', amount_usd: 10 }),
    ev('stopped', {}, 'human:keshav'),
    ev('done', {}, 'builder'),
    ev('stopped', {}, 'human:keshav'),
  ]);
  assert.equal(view.budget.reserved, 0);
  assert.equal(view.stop_reason, 'stopped');
  assert.deepEqual(view.warnings.map((w) => w.code), ['done_without_judge']);
});

test('a stopped campaign with a late passing judge is leaning, not answered', () => {
  const view = fold([
    started(),
    ev('stopped', {}, 'human:keshav'),
    ev('judge_ran', { passed: true, summary: 'late pass' }, 'judge'),
  ]);
  assert.equal(view.stop_reason, 'stopped');
  assert.deepEqual(view.answer, { text: 'late pass', confidence: 'leaning' });
});

test('a timestamp without a zone is refused, so no surface reads it in its own timezone', () => {
  assert.deepEqual(fold([started(), { ...ev('paused', {}, 'human:keshav'), at: '2026-10-15T10:00:30' }]), { error: 'invalid_event' });
  assert.deepEqual(fold([started(), { ...ev('paused', {}, 'human:keshav'), at: 'October 15, 2026' }]), { error: 'invalid_event' });
});

test('events a fraction of a millisecond apart sort as instants, not rounded', () => {
  const s = started();
  const paused = { ...ev('paused', {}, 'human:keshav'), at: '2026-10-15T11:00:00.0002Z', origin: 'a' };
  const resumed = { ...ev('resumed', {}, 'human:keshav'), at: '2026-10-15T11:00:00.0001Z', origin: 'b' };
  assert.equal(fold([s, paused, resumed]).state, 'paused');
  const offset = { ...ev('resumed', {}, 'human:keshav'), at: '2026-10-15T04:00:00.0003-07:00', origin: 'b', id: 'evt-late' };
  assert.equal(fold([s, paused, offset]).state, 'resting');
});

test('the view carries the basis the start named, and only atris_cloud or API billing pays dollars', () => {
  const saved = process.env.ATRIS_BILLING;
  delete process.env.ATRIS_BILLING;
  try {
    const cloud = fold([ev('campaign_started', { title: 'C', judge: 'exit 1', budget: 5, basis: 'atris_cloud' }, 'mission-lead')]);
    const own = fold([ev('campaign_started', { title: 'O', judge: 'exit 1', budget: 5, basis: 'own_engines' }, 'mission-lead')]);
    const plain = fold([started()]);
    assert.equal(cloud.basis, 'atris_cloud');
    assert.equal(own.basis, 'own_engines');
    assert.equal('basis' in plain, false);
    assert.equal(paysDollars(cloud), true);
    assert.equal(paysDollars(own), false);
    assert.equal(paysDollars(plain), false);
    process.env.ATRIS_BILLING = 'api';
    assert.equal(paysDollars(plain), true);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_BILLING;
    else process.env.ATRIS_BILLING = saved;
  }
});

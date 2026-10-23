'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../lib/campaign-core');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function summary(view) {
  const counts = { proposed: 0, claimed: 0, running: 0, ended: 0, vetoed: 0, dropped: 0 };
  for (const mission of view.missions) counts[mission.status]++;
  return { state: view.state, confidence: view.answer.confidence, judge_runs: view.judge_runs,
    budget: view.budget, mission_counts: counts, open_asks: view.asks.length };
}

test('compact status counts follow actual transitions while full APIs ignore global mission targets', () => {
  const events = [];
  const add = (type, data = {}, actor = 'owner') => {
    const seq = events.length + 1;
    events.push({ id: `status-${seq}`, campaign_id: 'cmp-status', origin: 'owned', seq,
      at: `2026-10-17T00:00:00.${String(seq).padStart(9, '0')}Z`, actor, type, data });
    return seq;
  };
  add('campaign_started', { title: 'Real status transitions', owner: 'owner', judge: 'check', budget: 10, standing: true });
  add('budget_reserved', { mission_id: 'ghost', amount_usd: 2 });
  add('budget_released', { mission_id: 'ghost' });
  add('mission_vetoed', { mission_id: 'unapproved-veto' }, 'outsider');
  add('step', { mission_id: 'step-job' });
  add('kept', { mission_id: 'kept-job' });
  add('reverted', { mission_id: 'reverted-job' });
  add('mission_started', { mission_id: 'started-job', member: 'worker' });
  add('mission_ended', { mission_id: 'ended-job', outcome: 'kept', cost_usd: 0.1 });
  add('mission_vetoed', { mission_id: 'veto-job' }, 'human:operator');
  add('mission_claimed', { mission_id: 'claimed-job', claim_key: 'shared' });
  add('mission_proposed', { mission_id: 'proposed-job', member: 'worker' });
  add('mission_proposed', { mission_id: 'claimed-job', member: 'ignored' });
  add('mission_claimed', { mission_id: 'claimed-job', claim_key: 'shared' });
  add('mission_claimed', { mission_id: 'drop-job', claim_key: 'shared' });
  add('mission_claimed', { mission_id: 'started-job', claim_key: 'shared' });
  add('mission_vetoed', { mission_id: 'started-job' });
  add('mission_vetoed', { mission_id: 'claimed-job' }, 'outsider');
  add('mission_started', { mission_id: 'drop-job', member: 'worker' });
  add('mission_claimed', { mission_id: 'veto-job', claim_key: 'other' });
  add('mission_claimed', { mission_id: 'ended-job', claim_key: 'ended' });
  add('mission_started', { mission_id: 'claimed-job', member: 'worker' });
  add('mission_vetoed', { mission_id: 'proposed-job' });
  add('mission_ended', { mission_id: 'drop-job', outcome: 'failed', cost_usd: 0.2 });
  add('mission_ended', { mission_id: 'veto-job', outcome: 'fault', cost_usd: 0.3, reason: 'owned setup fault' });
  add('mission_ended', { mission_id: 'started-job', outcome: 'kept', cost_usd: 0.4 });
  const repeated = add('mission_ended', { mission_id: 'ended-job', outcome: 'kept', cost_usd: 0.1 });
  const reserved = add('budget_reserved', { mission_id: 'claimed-job', amount_usd: 20 });
  add('ask_opened', { ask_id: 'q', question: 'Proceed?', mission_id: 'step-job' });
  const paused = add('paused');
  const judge = add('judge_ran', { passed: false, reading: 0.2, confidence: 'leaning', wait: { wake_at: 12345, wait_ms: 1000 } }, 'judge');
  const resumed = add('resumed');
  add('ask_answered', { ask_id: 'q', answer: 'yes' });
  add('ask_answered', { ask_id: 'q', answer: 'yes' }, 'human:operator');
  const exhausted = add('mission_ended', { mission_id: 'claimed-job', outcome: 'failed', cost_usd: 10 });
  add('budget_added', { amount_usd: 5, mission_id: 'global-only' });
  add('step', { mission_id: 'ended-job' });
  add('mission_ended', { mission_id: 'step-job', outcome: 'failed', cost_usd: 1 });
  add('judge_ran', { passed: true, reading: 0.6 }, 'judge');
  add('judge_set', { judge: 'ignored', mission_id: 'global-only' }, 'outsider');
  add('judge_set', { judge: 'replacement', mission_id: 'global-only' });
  add('judge_ran', { passed: true, reading: 0.8 }, 'judge');
  const stronger = add('judge_ran', { passed: true, reading: 1 }, 'judge');
  const finished = add('done', {}, 'human:operator');
  add('mission_started', { mission_id: 'after-finish', member: 'worker' });
  add('mission_ended', { mission_id: 'after-finish', outcome: 'kept', cost_usd: 0.5 });
  add('budget_reserved', { mission_id: 'ghost', amount_usd: 2 });

  let targetReads = 0;
  for (const [count, value] of [[paused, 'step-job'], [judge, 'global-only'], [resumed, 'step-job']]) {
    Object.defineProperty(events[count - 1].data, 'mission_id', { enumerable: true,
      get() { targetReads++; return value; } });
  }
  freeze(events);
  const input = JSON.stringify(events), counts = events.map((_, i) => i + 1);
  targetReads = 0;
  const final = core.fold(events);
  const foldReads = targetReads;
  targetReads = 0;
  const full = core.foldWithPrefixes(events, counts, view => view);
  const fullReads = targetReads;
  targetReads = 0;
  const compact = core.foldWithSummaryPrefixes(events, counts);
  const compactReads = targetReads;

  assert.equal(final.error, undefined);
  assert.equal(JSON.stringify(full.view), JSON.stringify(final));
  assert.equal(JSON.stringify(compact.view), JSON.stringify(final));
  for (const count of counts) {
    const expected = core.fold(events.slice(0, count));
    assert.equal(JSON.stringify(full.prefixes.get(count)), JSON.stringify(expected));
    assert.equal(JSON.stringify(compact.prefixes.get(count)), JSON.stringify(summary(expected)));
  }
  assert.equal(full.prefixes.get(judge).next_move.action, 'wait');
  assert.equal(full.prefixes.get(resumed).next_move, undefined);
  assert.equal(compact.prefixes.get(repeated).budget.spent, 1.1);
  assert.equal(compact.prefixes.get(reserved).state, 'running', 'a negative available budget does not mean spent out');
  assert.equal(compact.prefixes.get(reserved).budget.available, -11.1);
  assert.equal(compact.prefixes.get(exhausted).state, 'out_of_budget');
  assert.equal(compact.prefixes.get(stronger).confidence, 'stronger');
  assert.equal(compact.prefixes.get(finished).state, 'done');
  assert.equal(compact.view.state, 'done');
  assert.equal(compact.view.budget.spent, 12.6);
  assert.equal(compact.prefixes.get(events.length).mission_counts.ended,
    compact.prefixes.get(finished).mission_counts.ended + 1);
  assert.ok(!final.missions.some(row => ['ghost', 'global-only', 'unapproved-veto'].includes(row.id)));
  const last = compact.prefixes.get(events.length);
  assert.notStrictEqual(last.mission_counts, compact.prefixes.get(1).mission_counts);
  compact.prefixes.get(1).mission_counts.ended = 999;
  assert.equal(last.mission_counts.ended, final.missions.filter(row => row.status === 'ended').length);
  assert.equal(JSON.stringify(events), input);
  assert.equal(foldReads, 0, 'default folds do not read otherwise unused global targets');
  assert.equal(fullReads, 0, 'full prefix projectors retain their original target-read behavior');
  assert.ok(compactReads <= 3, `${compactReads} target reads exceeds one per selected global event`);
});

const STATUS_PROBE = String.raw`
const assert = require('node:assert/strict');
const { buildTrace } = require(require('node:path').join(process.argv[1], 'lib/campaign-trace'));
const n = 256, events = [];
function add(type, data) {
  const seq = events.length + 1;
  events.push({ id:'walk-'+seq, campaign_id:'cmp-walk', origin:'owned', seq, actor:'owner',
    at:new Date(Date.UTC(2026,9,17)+seq).toISOString(), type, data });
}
add('campaign_started', { title:'Real private mission scans', owner:'owner', judge:'check', budget:10000, standing:true });
add('judge_ran', { passed:false, reading:0.2 });
for (let i=0; i<n; i++) {
  const mission_id = 'walk-m-'+i;
  add('mission_proposed', { mission_id, member:'worker' });
  add('mission_ended', { mission_id, outcome:'kept', cost_usd:0 });
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
freeze(events);
const input = JSON.stringify(events), plain = buildTrace(events, { redact:false });
const original = Map.prototype.values;
const shape = 'id|member|status|outcome|costCents|estimate_usd|steps|kept|reverted';
let visits = 0, observed;
Map.prototype.values = function (...args) {
  const iterator = Reflect.apply(original, this, args), next = iterator.next;
  return {
    next(...nextArgs) {
      const result = Reflect.apply(next, iterator, nextArgs);
      const row = result.value;
      if (!result.done && row && typeof row === 'object' && typeof row.id === 'string' &&
        row.id.startsWith('walk-m-') && Object.keys(row).join('|') === shape) visits++;
      return result;
    },
    [Symbol.iterator]() { return this; },
  };
};
try { observed = buildTrace(events, { redact:false }); }
finally { Map.prototype.values = original; }
const measured = visits;
assert.equal(observed.error, undefined);
assert.equal(JSON.stringify(observed), JSON.stringify(plain));
assert.equal(JSON.stringify(events), input);
assert.equal(observed.header.final.state, 'resting');
assert.equal(observed.rows.length, n);
assert.ok(observed.rows.every((row,i) => row.state_before.missions.ended === i && row.reward === null && row.reading_after === null));
console.log(JSON.stringify({ missions:n, private_mission_yields:measured, trace_rows:observed.rows.length }));
`;

test('actual trace summaries visit only the mandatory linear final mission maps', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-'));
  const root = path.join(parent, 'work'), marker = path.join(parent, 'foreign');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive:true, force:true });
      assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
    } finally { fs.rmSync(parent, { recursive:true, force:true }); }
  });
  fs.writeFileSync(marker, 'retain');
  fs.mkdirSync(root);
  const child = spawnSync(process.execPath, ['-e', STATUS_PROBE, path.resolve(__dirname, '..')], {
    cwd:root, env:{ ...process.env }, encoding:'utf8', timeout:30000, maxBuffer:1024*1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const measured = JSON.parse(child.stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.trace_rows, measured.missions);
  assert.ok(measured.private_mission_yields >= 2 * measured.missions, 'the final full views still traverse actual mission rows');
  assert.ok(measured.private_mission_yields <= 4 * measured.missions,
    `${measured.private_mission_yields} private mission yields for ${measured.missions} missions exceeds the linear bound`);
});

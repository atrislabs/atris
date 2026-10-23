'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../lib/campaign-core');
const { buildTrace, readingOf } = require('../lib/campaign-trace');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function canonical(events) {
  const seen = new Set();
  const ordered = events.filter(event => seen.has(event.id) ? false : seen.add(event.id)).sort(core.compareEvents);
  const start = ordered.find(event => event.type === 'campaign_started');
  return [start, ...ordered.filter(event => event !== start)];
}

// Project the actual public fold, not a second event reducer.
function summary(view) {
  const counts = { proposed: 0, claimed: 0, running: 0, ended: 0, vetoed: 0, dropped: 0 };
  for (const mission of view.missions) counts[mission.status]++;
  return { state: view.state, confidence: view.answer.confidence, judge_runs: view.judge_runs,
    budget: view.budget, mission_counts: counts, open_asks: view.asks.length };
}

function checkPrefixes(events) {
  assert.equal(typeof core.foldWithSummaryPrefixes, 'function');
  const sequence = canonical(events);
  const counts = sequence.map((_, i) => i + 1);
  const before = JSON.stringify(events);
  const result = core.foldWithSummaryPrefixes(events,
    [...counts].reverse().concat(1, sequence.length, 0, -1, sequence.length + 1, 1.5, '1', NaN, Infinity));
  assert.equal(JSON.stringify(result.view), JSON.stringify(core.fold(events)));
  assert.ok(result.prefixes instanceof Map);
  assert.deepEqual([...result.prefixes.keys()], counts);
  for (const count of counts) {
    const expected = summary(core.fold(sequence.slice(0, count)));
    assert.deepEqual(result.prefixes.get(count), expected, `canonical prefix ${count}`);
    assert.equal(JSON.stringify(result.prefixes.get(count)), JSON.stringify(expected), 'summary key order is stable');
  }
  assert.equal(JSON.stringify(events), before);
  return { result, sequence };
}

test('compact summaries match every full golden prefix without changing the public view', () => {
  const dir = path.join(__dirname, 'fixtures', 'campaign');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json') && !['MANIFEST.json', 'decide-cases.json'].includes(name))) {
    const golden = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (golden.expected.error) continue;
    const { result } = checkPrefixes(freeze(golden.events));
    assert.deepEqual(result.view, golden.expected, golden.name);
  }
});

test('summary prefixes retain lifecycle precedence, detached counts and strict trace start state', () => {
  const events = [];
  const add = (type, data = {}, actor = 'owner') => {
    const seq = events.length + 1;
    events.push({ id: `summary-${seq}`, campaign_id: 'cmp-summary', origin: 'owned', seq,
      at: `2026-10-17T00:00:00.${String(seq).padStart(9, '0')}Z`, type, actor, data });
    return seq;
  };
  add('campaign_started', { title: 'Compact states', owner: 'owner', judge: 'check', budget: 3, standing: true });
  add('judge_ran', { passed: false, reading: 0.1, confidence: 'leaning' }, 'judge');
  add('budget_reserved', { mission_id: 'ghost', amount_usd: 0.5 });
  add('mission_proposed', { mission_id: 'first', member: 'worker', estimate_usd: 0.75 });
  add('mission_claimed', { mission_id: 'first', claim_key: 'shared' });
  add('mission_claimed', { mission_id: 'dropped', claim_key: 'shared' });
  add('mission_vetoed', { mission_id: 'vetoed' }, 'human:operator');
  add('mission_started', { mission_id: 'dropped', member: 'worker' });
  add('mission_started', { mission_id: 'vetoed', member: 'worker' });
  add('mission_started', { mission_id: 'first', member: 'worker' });
  add('budget_reserved', { mission_id: 'first', amount_usd: 0.75 });
  add('ask_opened', { ask_id: 'question', question: 'Proceed?', mission_id: 'first' });
  add('ask_answered', { ask_id: 'question', answer: 'yes' });
  add('judge_ran', { passed: false, reading: 0.35 }, 'judge');
  add('paused');
  add('mission_ended', { mission_id: 'dropped', outcome: 'failed', cost_usd: 1.25 });
  add('mission_ended', { mission_id: 'vetoed', outcome: 'fault', cost_usd: 0.1, reason: 'owned setup fault' });
  const exhausted = add('mission_ended', { mission_id: 'first', outcome: 'kept', cost_usd: 1.65 });
  const recovered = add('budget_added', { amount_usd: 0.4 });
  add('resumed');
  add('ask_answered', { ask_id: 'question', answer: 'yes' }, 'human:operator');
  add('budget_released', { mission_id: 'ghost' });
  add('budget_reserved', { mission_id: 'first', amount_usd: 9 });
  add('mission_ended', { mission_id: 'first', outcome: 'kept', cost_usd: 0.1 });
  add('judge_set', { judge: 'ignored' }, 'outsider');
  add('judge_ran', { passed: true, reading: 0.8 }, 'judge');
  add('judge_set', { judge: 'replacement' });
  add('judge_ran', { passed: true, reading: 0.9 }, 'judge');
  const stronger = add('judge_ran', { passed: true, reading: 1 }, 'judge');
  add('done', {}, 'human:operator');
  add('ask_opened', { ask_id: 'late', question: 'After finishing?' });
  const input = freeze([...events].reverse().concat({ ...events[1], data: { passed: false, reading: 0.99 } }));
  const { result, sequence } = checkPrefixes(input);
  assert.equal(result.prefixes.get(exhausted).state, 'out_of_budget');
  assert.equal(result.prefixes.get(recovered).state, 'paused');
  assert.equal(result.prefixes.get(recovered).budget.available, -0.1);
  assert.equal(result.prefixes.get(stronger).confidence, 'stronger', 'accepted resets do not erase the historical passing streak');
  assert.equal(result.view.state, 'done');
  assert.equal(result.view.budget.spent, 3.1, 'a repeated end still charges its real cost');
  for (let count = 2; count <= sequence.length; count++) {
    assert.notStrictEqual(result.prefixes.get(count).budget, result.prefixes.get(count - 1).budget);
    assert.notStrictEqual(result.prefixes.get(count).mission_counts, result.prefixes.get(count - 1).mission_counts);
  }
  result.prefixes.get(1).budget.total = 999;
  result.prefixes.get(1).mission_counts.ended = 999;
  assert.equal(result.prefixes.get(2).budget.total, 3);
  assert.equal(result.prefixes.get(2).mission_counts.ended, 0);
  assert.equal(result.view.budget.total, 3.4);

  const trace = buildTrace(input, { redact: false });
  assert.equal(trace.rows.find(row => row.action.mission_id === 'first').state_before.reading, 0.1);
  assert.equal(trace.rows.find(row => row.action.mission_id === 'first').reading_before, 0.35);
  for (const row of trace.rows) {
    const first = sequence.findIndex(event => event.data.mission_id === row.action.mission_id && !['budget_reserved', 'budget_released'].includes(event.type));
    const view = core.fold(sequence.slice(0, Math.max(1, first)));
    const compact = summary(view);
    const reading = readingOf(view.last_judge && { ...view.last_judge, summary: view.answer.text }).value;
    const expected = { state: compact.state, reading, confidence: compact.confidence, judge_runs: compact.judge_runs,
      budget: compact.budget, missions: compact.mission_counts, open_asks: compact.open_asks };
    assert.equal(JSON.stringify(row.state_before), JSON.stringify(expected));
  }
  const invalid = { ...events[1], data: { passed: 'wrong' } };
  const foreign = { ...events[1], campaign_id: 'cmp-foreign' };
  for (const raw of [null, [], [events[1]], [...events, invalid], [...events, foreign]]) {
    assert.deepEqual(core.foldWithSummaryPrefixes(raw, [1, 2, 3]), core.fold(raw));
  }
});

// Observe only this actual map allocation site in a fresh child. The wrapper
// returns the real rows untouched; it never substitutes events or fold results.
const ALLOCATION_PROBE = String.raw`
const assert = require('node:assert/strict');
const { buildTrace } = require(require('node:path').join(process.argv[1], 'lib/campaign-trace'));
const n = 256;
const events = [];
function add(type, data) {
  const seq = events.length + 1;
  events.push({ id: 'allocation-'+seq, campaign_id: 'cmp-allocation', origin: 'owned', seq,
    actor: 'owner', at: new Date(Date.UTC(2026,9,17)+seq).toISOString(), type, data });
}
add('campaign_started', { title: 'Real prefix allocations', judge: 'check', owner: 'owner', budget: 10000, standing: true });
add('judge_ran', { passed: false, reading: 0.2 });
for (let i=0; i<n; i++) {
  const mission_id = 'allocation-m-'+i;
  add('mission_proposed', { mission_id, member: 'worker' });
  add('mission_ended', { mission_id, outcome: 'kept', cost_usd: 0 });
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
freeze(events);
const before = JSON.stringify(events);
const plain = buildTrace(events, { redact: false });
const original = Array.prototype.map;
const shape = 'id|member|status|outcome|cost_usd|estimate_usd|steps|kept|reverted';
let publicRows = 0;
let observed;
Array.prototype.map = function (...args) {
  const rows = Reflect.apply(original, this, args);
  if (rows.length && rows.every(row => row && typeof row === 'object' &&
    typeof row.id === 'string' && row.id.startsWith('allocation-m-') && Object.keys(row).join('|') === shape)) publicRows += rows.length;
  return rows;
};
try { observed = buildTrace(events, { redact: false }); }
finally { Array.prototype.map = original; }
const measured = publicRows;
assert.equal(observed.error, undefined);
assert.equal(JSON.stringify(observed), JSON.stringify(plain));
assert.equal(JSON.stringify(events), before);
assert.equal(observed.header.final.state, 'resting');
assert.equal(observed.rows.length, n);
assert.ok(observed.rows.every((row, i) => row.state_before.missions.ended === i && row.reward === null && row.reading_after === null));
assert.deepEqual(Object.keys(observed.rows[0].state_before), ['state','reading','confidence','judge_runs','budget','missions','open_asks']);
console.log(JSON.stringify({ missions: n, public_rows: measured, trace_rows: observed.rows.length }));
`;

test('actual trace prefix rendering allocates only a linear number of full public mission rows', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-'));
  const root = path.join(parent, 'work');
  const marker = path.join(parent, 'foreign');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  fs.writeFileSync(marker, 'retain');
  fs.mkdirSync(root);
  const child = spawnSync(process.execPath, ['-e', ALLOCATION_PROBE, path.resolve(__dirname, '..')], {
    cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const measured = JSON.parse(child.stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.trace_rows, measured.missions);
  assert.ok(measured.public_rows >= 2 * measured.missions, 'both final public folds remain real');
  assert.ok(measured.public_rows <= 4 * measured.missions,
    `${measured.public_rows} public mission rows for ${measured.missions} missions exceeds the linear allocation bound`);
});

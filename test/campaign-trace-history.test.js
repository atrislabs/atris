'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../lib/campaign-core');

function prefixFold() {
  assert.equal(typeof core.foldWithPrefixes, 'function',
    'campaign core must expose the requested-prefix fold helper');
  return core.foldWithPrefixes;
}

function canonical(events) {
  const seen = new Set();
  const ordered = events.filter(event => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  }).sort(core.compareEvents);
  const start = ordered.find(event => event.type === 'campaign_started');
  return [start, ...ordered.filter(event => event !== start)];
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function history() {
  const events = [];
  const add = (type, data = {}, actor = 'owner', overrides = {}) => {
    const seq = events.length + 1;
    const event = { id: `history-${seq}`, campaign_id: 'cmp-history', origin: 'local', seq,
      at: new Date(Date.UTC(2026, 9, 16, 10, 0, seq)).toISOString(), type, actor, data, ...overrides };
    events.push(event);
    return event;
  };
  add('campaign_started', { title: 'Requested history', judge: 'old-check', budget: 100,
    owner: 'owner', seats: [{ member: 'seed', role: 'builder' }], bet: 'initial bet', standing: true,
    basis: 'own_engines' });
  add('judge_ran', { passed: false, reading: 0.2, summary: '2 of 10 live' }, 'judge');
  add('ask_opened', { ask_id: 'a1', question: 'Proceed?', mission_id: 'm1' });
  add('mission_proposed', { mission_id: 'm1', member: 'worker', estimate_usd: 4.25 });
  add('budget_reserved', { mission_id: 'm1', amount_usd: 4.25 });
  add('seat_filled', { member: 'reviewer', role: 'review' });
  add('judge_set', { judge: 'ignored-check' }, 'outsider');
  add('bet_set', { bet: 'later bet', wrong_if: 'the real check fails' });
  add('ask_answered', { ask_id: 'a1', answer: 'yes' }, 'human:operator');
  add('budget_added', { amount_usd: 0.35 });
  add('mission_claimed', { mission_id: 'm1', claim_key: 'one' });
  add('mission_started', { mission_id: 'm1', member: 'worker' });
  add('step', { mission_id: 'm1', engine: 'codex', cost_usd: 0.1 });
  add('mission_ended', { mission_id: 'm1', outcome: 'kept', cost_usd: 1.25 });
  add('judge_ran', { passed: true, summary: '10 of 10 live' }, 'judge');
  add('judge_ran', { passed: true }, 'judge');
  add('judge_ran', { passed: true }, 'judge');
  add('ask_opened', { ask_id: 'a2', question: 'Next question?' });
  add('seat_filled', { member: 'late', role: 'builder' });
  add('done', {}, 'worker');
  return events;
}

function checkPrefixes(events, requests) {
  const foldWithPrefixes = prefixFold();
  const sequence = canonical(events);
  const counts = [...new Set(requests.filter(n => Number.isSafeInteger(n) && n >= 1 && n <= sequence.length))].sort((a, b) => a - b);
  const expected = new Map(counts.map(n => [n, core.fold(sequence.slice(0, n))]));
  const calls = [];
  const before = JSON.stringify(events);
  const result = foldWithPrefixes(events, requests, (view, count) => {
    calls.push(count);
    return view;
  });
  assert.deepEqual(result.view, core.fold(events));
  assert.ok(result.prefixes instanceof Map);
  assert.deepEqual(calls, counts, 'each requested canonical count is projected once, in traversal order');
  assert.deepEqual([...result.prefixes], [...expected]);
  assert.equal(JSON.stringify(events), before, 'folding must not sort or mutate input records');
  return result;
}

test('requested canonical prefixes match the existing fold for every valid golden', () => {
  prefixFold();
  const dir = path.join(__dirname, 'fixtures', 'campaign');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !['MANIFEST.json', 'decide-cases.json'].includes(f))) {
    const golden = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (golden.expected.error) continue;
    const events = freeze(golden.events);
    const n = canonical(events).length;
    const requests = [n, 1, ...Array.from({ length: n }, (_, i) => i + 1), n, 1, 0, -1, n + 1, 1.5, '1', NaN, Infinity];
    assert.deepEqual(checkPrefixes(events, requests).view, golden.expected, golden.name);
  }
});

test('prefix counts use unique start-first order with frozen shuffled nanosecond events', () => {
  const events = history();
  events.push({ ...events[0], id: 'duplicate-start', at: '2026-10-16T10:00:03.5Z',
    data: { title: 'Ignored duplicate start', judge: 'not-owner-check', budget: 900 } });
  events.push({ ...events[0], id: 'pre-start', type: 'paused', data: {}, at: '2026-10-16T09:59:59Z' });
  events.push({ ...events[0], id: 'nano-paused', type: 'paused', data: {}, origin: 'a', at: '2026-10-16T10:00:30.000000002Z' });
  events.push({ ...events[0], id: 'nano-resumed', type: 'resumed', data: {}, origin: 'z', at: '2026-10-16T03:00:30.000000001-07:00' });
  const duplicate = { ...events[1], data: { passed: false, reading: 0.9, summary: 'conflicting duplicate' } };
  for (const input of [events, [...events].reverse(), [...events.slice(7), ...events.slice(0, 7)]]) {
    const raw = freeze([...input, duplicate]);
    const sequence = canonical(raw);
    assert.equal(sequence[0].type, 'campaign_started');
    assert.equal(sequence[1].id, 'pre-start');
    assert.ok(sequence.findIndex(e => e.id === 'nano-resumed') < sequence.findIndex(e => e.id === 'nano-paused'));
    const result = checkPrefixes(raw, sequence.map((_, i) => i + 1));
    assert.equal(result.view.state, 'paused');
    assert.equal(result.view.judge, 'old-check');
    assert.equal(result.prefixes.get(3).last_judge.reading, 0.2, 'the first raw duplicate payload wins');
  }
});

test('retained prefix views detach standard containers and their rows from later states', () => {
  const events = freeze(history());
  const result = checkPrefixes(events, events.map((_, i) => i + 1));
  const at3 = result.prefixes.get(3);
  const at4 = result.prefixes.get(4);
  const at7 = result.prefixes.get(7);
  const final = result.view;
  assert.deepEqual(at3.seats, [{ member: 'seed', role: 'builder' }]);
  assert.deepEqual(at3.warnings, []);
  assert.deepEqual(at3.asks, [{ id: 'a1', question: 'Proceed?', mission_id: 'm1' }]);
  assert.deepEqual(at3.bet, { text: 'initial bet', wrong_if: null });
  assert.equal(at3.budget.total, 100);
  assert.equal(at3.budget.reserved, 0);
  assert.equal(at3.missions.length, 0);
  assert.equal(at4.missions[0].status, 'proposed');
  assert.equal(final.missions[0].status, 'ended');
  assert.equal(final.budget.total, 100.35);
  assert.equal(final.budget.spent, 1.25);
  assert.equal(final.seats.length, 3);
  assert.equal(final.warnings.length, 2);
  for (const key of ['seats', 'asks', 'warnings', 'bet', 'missions', 'answer', 'budget', 'last_judge']) {
    assert.notStrictEqual(at3[key], at4[key], `${key} containers must be detached`);
  }
  for (const key of ['seats', 'asks']) assert.notStrictEqual(at3[key][0], at4[key][0], `${key} rows must be detached`);
  assert.notStrictEqual(at7.warnings[0], result.prefixes.get(8).warnings[0]);
  assert.notStrictEqual(at4.missions[0], result.prefixes.get(5).missions[0]);
});

test('whole-input refusals happen before any requested-prefix callback', () => {
  const foldWithPrefixes = prefixFold();
  const events = history();
  const invalidDuplicate = { ...events[1], data: { passed: 'not a boolean' } };
  const foreignDuplicate = { ...events[1], campaign_id: 'cmp-other' };
  for (const [input, error] of [
    [[...events, invalidDuplicate], 'invalid_event'],
    [[...events, foreignDuplicate], 'mixed_campaigns'],
    [[events[1]], 'no_start'],
    [[], 'no_start'],
    [null, 'invalid_event'],
  ]) {
    let calls = 0;
    assert.deepEqual(foldWithPrefixes(input, [1, 2], () => { calls++; return 'must not run'; }), { error });
    assert.equal(calls, 0);
    assert.deepEqual(core.fold(input), { error });
  }
});

test('a synchronous projector keeps only its result and propagates its exact exception', () => {
  const foldWithPrefixes = prefixFold();
  const events = freeze(history());
  const counts = [events.length, 1, 3, 3, 0, -1, events.length + 1];
  const projected = foldWithPrefixes(events, counts, (view, count) => ({ count, seats: view.seats.length, spent: view.budget.spent }));
  assert.deepEqual([...projected.prefixes], [[1, { count: 1, seats: 1, spent: 0 }], [3, { count: 3, seats: 1, spent: 0 }], [events.length, { count: events.length, seats: 3, spent: 1.25 }]]);
  assert.deepEqual(projected.view, core.fold(events));
  const marker = new Error('owned projector failure');
  assert.throws(() => foldWithPrefixes(events, [1, 3], () => { throw marker; }), error => error === marker);
});

// A fresh child intercepts the exported validator before core captures it. The
// wrapper counts and always calls the real validator, never replacing a view,
// event, clock, validation result or reducer. There is no wall-clock threshold.
const COST_PROBE = String.raw`
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const source = process.argv[1];
const schema = require(path.join(source, 'lib/campaign-schema'));
const original = schema.validateEvent;
let visits = 0;
schema.validateEvent = event => { visits++; return original(event); };
const { buildTrace } = require(path.join(source, 'lib/campaign-trace'));
function fixture(n, ended) {
  const events = [];
  const add = (type, data) => { const seq = events.length + 1; events.push({ id:'cost-'+seq, campaign_id:'cmp-cost', origin:'owned', seq, actor:'owner', at:new Date(Date.UTC(2026,9,16)+seq).toISOString(), type, data }); };
  add('campaign_started', {title:'Actual history cost', owner:'owner', judge:'exit 1', budget:100000});
  add('judge_ran', {passed:false, reading:0.2});
  for(let i=0;i<n;i++) {
    const mission_id='m-'+i;
    add('mission_proposed', {mission_id, member:'worker', objective:'Real bounded work'});
    add('mission_claimed', {mission_id, claim_key:'claim-'+i});
    add('mission_started', {mission_id, member:'worker'});
    add('step', {mission_id, engine:'codex', cost_usd:0});
    add(ended?'mission_ended':'kept', ended?{mission_id,outcome:'kept',cost_usd:0}:{mission_id});
  }
  return events;
}
const samples=[];
for(const n of [100,250,500,1000]) {
  const events=fixture(n,true); visits=0;
  const trace=buildTrace(events,{redact:false});
  assert.equal(trace.error,undefined); assert.equal(trace.rows.length,n); assert.equal(trace.header.events,events.length); assert.equal(trace.header.final.state,'resting');
  assert.equal(trace.rows[0].state_before.missions.ended,0); assert.equal(trace.rows[n-1].state_before.missions.ended,n-1);
  assert.ok(trace.rows.every(row=>row.reward===null&&row.reading_after===null));
  samples.push({missions:n,events:events.length,validator_visits:visits,trace_sha256:crypto.createHash('sha256').update(JSON.stringify(trace)).digest('hex')});
}
const pending=fixture(1000,false); visits=0;
const empty=buildTrace(pending); assert.equal(empty.error,undefined); assert.equal(empty.rows.length,0); assert.equal(empty.header.pending_missions,1000);
console.log(JSON.stringify({samples,no_ended:{events:pending.length,validator_visits:visits}}));
`;

function measured(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-trace-history-cost-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ATRIS_TEST_STATE_DIR: path.join(root, 'owned-user-state') };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['-e', COST_PROBE, path.resolve(__dirname, '..')], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout);
  t.diagnostic(JSON.stringify(result));
  return result;
}

// Keep both assertions in one fresh measurement so failure still reports the
// genuine 1,000-mission old-runtime cost and the no-ended control together.
test('trace history validates a bounded number of actual events and skips unused prefix work', t => {
  const result = measured(t);
  assert.equal(result.no_ended.validator_visits, result.no_ended.events, 'no ended missions must add no prefix pass');
  for (const sample of result.samples) {
    assert.ok(sample.validator_visits <= 3 * sample.events,
      `${sample.missions} missions: ${sample.validator_visits} real validator visits exceeds 3 * ${sample.events} events`);
  }
});

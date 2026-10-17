'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTrace, traceLines } = require('../lib/campaign-trace');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function history(standing = false, start = {}) {
  const events = [];
  const add = (type, data = {}, actor = 'owner', extra = {}) => {
    const seq = events.length + 1;
    const event = { id: `finish-case-${seq}`, campaign_id: 'cmp-finish-case', origin: 'owned', seq,
      at: new Date(Date.UTC(2026, 9, 17) + (seq - 1) * 1000).toISOString(), type, actor, data, ...extra };
    events.push(event);
    return event;
  };
  add('campaign_started', { title: 'private finish history', owner: 'owner', judge: 'node private-check.js',
    budget: 10, standing, ...start });
  return { events, add };
}

function check(h, expected, conflict = null) {
  const input = freeze(h.events.concat(conflict ? [conflict] : []));
  const bytes = JSON.stringify(input), full = buildTrace(input, { redact: false }), redacted = buildTrace(input);
  assert.equal(full.error, undefined);
  assert.equal(full.header.final.state, expected.state);
  assert.equal(full.header.final.stop_reason, expected.reason);
  assert.deepEqual(full.rows.map(row => row.done), expected.done);
  if (expected.reward) assert.deepEqual(full.rows.map(row => row.reward), expected.reward);
  if (expected.confidence) assert.equal(full.header.final.confidence, expected.confidence);
  assert.deepEqual(redacted.rows.map(row => [row.done, row.reward, row.cost_usd, row.outcome, row.state_before]),
    full.rows.map(row => [row.done, row.reward, row.cost_usd, row.outcome, row.state_before]));
  assert.doesNotMatch(traceLines(redacted), /private/);
  for (const order of [[...h.events].reverse(), [...h.events.slice(2), ...h.events.slice(0, 2)]]) {
    const raw = freeze(order.concat(conflict ? [conflict] : []));
    assert.equal(traceLines(buildTrace(raw, { redact: false })), traceLines(full));
    assert.equal(traceLines(buildTrace(raw)), traceLines(redacted));
  }
  assert.equal(JSON.stringify(input), bytes);
  return full;
}

test('trace finish flags follow real scoring boundaries across empty, early and late histories', () => {
  for (const standing of [false, true]) {
    const h = history(standing);
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('mission_started', { mission_id: 'work', member: 'worker' });
    h.add('mission_ended', { mission_id: 'work', outcome: 'kept', cost_usd: 0.1 });
    h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
    check(h, { state: standing ? 'resting' : 'done', reason: standing ? null : 'judge_passed',
      confidence: standing ? 'leaning' : 'answered', done: [!standing], reward: [0.8] });
  }
  for (const kind of ['done', 'stopped']) {
    const h = history(true);
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('mission_ended', { mission_id: 'old', outcome: 'kept', cost_usd: 0.1 });
    h.add('judge_ran', { passed: false, reading: 0.3 }, 'judge');
    h.add(kind, {}, kind === 'done' ? 'human:operator' : 'owner');
    h.add('mission_ended', { mission_id: 'new', outcome: 'kept', cost_usd: 0.2 });
    h.add('judge_ran', { passed: false, reading: 0.4 }, 'judge');
    h.add('resumed');
    h.add('judge_set', { judge: 'node private-replacement.js' });
    check(h, { state: 'done', reason: kind === 'done' ? 'done_by_human' : 'stopped', done: [false, true] });
  }
  {
    const h = history(true);
    h.add('stopped');
    h.add('ask_opened', { ask_id: 'a', question: 'private question' });
    h.add('budget_added', { amount_usd: 1 });
    h.add('resumed');
    h.add('judge_set', { judge: 'node private-replacement.js' });
    h.add('mission_proposed', { mission_id: 'later', member: 'worker' });
    h.add('mission_ended', { mission_id: 'later', outcome: 'kept', cost_usd: 0 });
    h.add('judge_ran', { passed: false, reading: 0.4 }, 'judge');
    const full = check(h, { state: 'done', reason: 'stopped', done: [true] });
    assert.equal(full.rows[0].state_before.state, 'done');
  }
  {
    const h = history();
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('mission_proposed', { mission_id: 'early', member: 'worker' });
    h.add('mission_claimed', { mission_id: 'early', claim_key: 'early' });
    h.add('step', { mission_id: 'early' });
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('mission_ended', { mission_id: 'early', outcome: 'kept', cost_usd: 0 });
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('mission_ended', { mission_id: 'late', outcome: 'kept', cost_usd: 0 });
    for (let i = 0; i < 9; i++) h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
    const full = check(h, { state: 'done', reason: 'judge_passed', done: [false, false], reward: [0, 0] });
    assert.equal(full.rows[0].state_before.missions.claimed, 0, 'the first proposal state stays earlier than its late end');
  }
  for (const finish of [null, 'done', 'stopped']) {
    const h = history(true);
    h.add('mission_started', { mission_id: 'pending', member: 'worker' });
    h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
    if (finish) h.add(finish, {}, finish === 'done' ? 'human:operator' : 'owner');
    const full = check(h, { state: finish ? 'done' : 'running',
      reason: finish === 'done' ? 'done_by_human' : finish === 'stopped' ? 'stopped' : null, done: [] });
    assert.equal(full.header.pending_missions, 1);
  }
  {
    const h = history(true);
    h.add('judge_ran', { passed: true, reading: 1 }, 'judge');
    h.add('done', {}, 'worker');
    check(h, { state: 'resting', reason: null, done: [], confidence: 'leaning' });
  }
  {
    const h = history(true, { budget: 0.1 });
    h.add('mission_ended', { mission_id: 'spent', outcome: 'kept', cost_usd: 0.1 });
    h.add('budget_added', { amount_usd: 1 });
    h.add('done', {}, 'worker');
    check(h, { state: 'resting', reason: null, done: [false] });
  }
  {
    const h = history(true, { mission_id: 'from-start' });
    h.add('mission_vetoed', { mission_id: 'ignored' }, 'outsider');
    h.add('done', {}, 'human:operator');
    h.add('mission_ended', { mission_id: 'from-start', outcome: 'kept', cost_usd: 0 });
    h.add('mission_ended', { mission_id: 'ignored', outcome: 'failed', cost_usd: 0 });
    h.add('judge_ran', { passed: false, reading: 0.4 }, 'judge');
    const full = check(h, { state: 'done', reason: 'done_by_human', done: [true, true] });
    assert.deepEqual(full.rows[0].state_before, full.rows[1].state_before, 'first positions0 and1 both request actual prefix1');
    assert.equal(full.rows[0].state_before.missions.ended, 0);
  }
  {
    const h = history();
    h.add('paused', {}, 'owner', { at: '2026-10-16T23:59:59Z' });
    h.add('campaign_started', { title: 'ignored start', judge: 'ignored', budget: 999 }, 'owner', { at: '2026-10-17T00:00:00.5Z' });
    h.add('resumed', {}, 'owner', { at: '2026-10-17T00:00:01Z' });
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge', { at: '2026-10-17T00:00:02Z' });
    h.add('mission_ended', { mission_id: 'old', outcome: 'kept', cost_usd: 0 }, 'owner', { at: '2026-10-17T00:00:03Z' });
    const finish = h.add('done', {}, 'human:operator', { at: '2026-10-16T17:00:04.000000002-07:00', origin: 'a' });
    h.add('judge_ran', { passed: false, reading: 0.4 }, 'judge', { at: '2026-10-17T00:00:04.000000001Z', origin: 'z' });
    h.add('mission_ended', { mission_id: 'after', outcome: 'kept', cost_usd: 0 }, 'owner', { at: '2026-10-17T00:00:05Z' });
    check(h, { state: 'done', reason: 'done_by_human', done: [false, true] }, { ...finish, actor: 'worker' });
  }
});

const VALIDATION_PROBE = String.raw`
const assert = require('node:assert/strict'), path = require('node:path');
const source = process.argv[1], mode = process.argv[2];
assert.ok(mode === 'clean' || mode === 'counted');
const schema = require(path.join(source, 'lib/campaign-schema'));
const original = schema.validateEvent;
let visits = 0, reports = [];
if (mode === 'counted') schema.validateEvent = function (...args) { visits++; return Reflect.apply(original, this, args); };
try {
  const { buildTrace } = require(path.join(source, 'lib/campaign-trace'));
  for (const standing of [false, true]) {
    const events = [], n = 256;
    const add = (type, data) => { const seq = events.length + 1; events.push({ id:'finish-work-'+seq,
      campaign_id:'cmp-finish-work', origin:'owned', seq, actor:'owner',
      at:new Date(Date.UTC(2026,9,17)+(seq-1)*1000).toISOString(), type, data }); };
    add('campaign_started', { title:'Actual finish-search work', owner:'owner', judge:'check', budget:100, standing });
    add('judge_ran', { passed:false, reading:0.2 });
    for (let i=0; i<n; i++) {
      const mission_id = 'finish-m-'+i;
      add('mission_started', { mission_id, member:'worker' });
      add('step', { mission_id, cost_usd:0 });
      add('mission_ended', { mission_id, outcome:'kept', cost_usd:0 });
      add('judge_ran', { passed:i===n-1, reading:i===n-1?1:0.2 });
    }
    function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
    freeze(events);
    const before = JSON.stringify(events);
    visits = 0;
    const trace = buildTrace(events, { redact:false });
    const actualVisits = visits;
    assert.equal(JSON.stringify(events), before);
    reports.push({ standing, events:events.length, input:events, trace, validations:mode==='counted'?actualVisits:null });
  }
} finally { schema.validateEvent = original; }
assert.strictEqual(schema.validateEvent, original);
console.log(JSON.stringify(reports));
`;

test('finished dense histories avoid repeated whole-prefix validation while standing controls stay unchanged', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-'));
  const root = path.join(parent, 'work'), marker = path.join(parent, 'foreign');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive:true, force:true });
      assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
    } finally { fs.rmSync(parent, { recursive:true, force:true }); }
  });
  fs.writeFileSync(marker, 'retain');
  fs.mkdirSync(root);
  const run = mode => {
    const child = spawnSync(process.execPath, ['-e', VALIDATION_PROBE, path.resolve(__dirname, '..'), mode], {
      cwd:root, env:{ ...process.env }, encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  const clean = run('clean'), counted = run('counted');
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(counted[i].input, clean[i].input);
    assert.equal(JSON.stringify(counted[i].trace), JSON.stringify(clean[i].trace));
    const { standing, trace } = counted[i];
    assert.equal(trace.error, undefined);
    assert.equal(trace.header.final.state, standing ? 'resting' : 'done');
    assert.equal(trace.header.final.stop_reason, standing ? null : 'judge_passed');
    assert.equal(trace.header.final.confidence, standing ? 'leaning' : 'answered');
    assert.equal(trace.rows.length, 256);
    assert.ok(trace.rows.every((row,j) => row.done === (!standing && j===255) && row.reward === (j===255?0.8:0)));
  }
  const dense = counted[0], standing = counted[1];
  t.diagnostic(JSON.stringify({ events:dense.events, dense_validations:dense.validations,
    standing_validations:standing.validations, finish_validation_delta:dense.validations-standing.validations }));
  assert.equal(standing.validations, 2 * standing.events);
  assert.ok(dense.validations <= 5 * dense.events,
    `${dense.validations} actual validations for ${dense.events} events exceeds the dense finish-work bound`);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const core = require('../lib/campaign-core');
const { buildTrace } = require('../lib/campaign-trace');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function history(standing = true) {
  const events = [];
  const add = (type, data = {}, actor = type === 'judge_ran' ? 'judge' : 'owner') => {
    const seq = events.length + 1;
    events.push({ id:'confidence-'+seq, campaign_id:'cmp-confidence-streak', type,
      at:'2026-10-17T00:00:00.'+String(seq).padStart(9, '0')+'Z', origin:'owned', seq, actor, data });
    return seq;
  };
  add('campaign_started', { title:'PRIVATE_TITLE', owner:'owner', judge:'node PRIVATE_JUDGE.js', budget:2, standing });
  return { events, add };
}
function check(events, confidence, state = 'resting') {
  freeze(events);
  const input = JSON.stringify(events), seen = new Set();
  const ordered = events.filter(e => seen.has(e.id) ? false : seen.add(e.id)).sort(core.compareEvents);
  const start = ordered.find(e => e.type === 'campaign_started');
  const sequence = [start, ...ordered.filter(e => e !== start)], counts = sequence.map((_, i) => i + 1);
  const view = core.fold(events), full = core.foldWithPrefixes(events, counts);
  const compact = core.foldWithSummaryPrefixes(events, counts), called = [];
  const projected = core.foldWithPrefixes(events, counts, function (value, count) {
    assert.equal(arguments.length, 2); called.push(count);
    return { count, confidence:value.answer.confidence };
  });
  assert.equal(view.error, undefined);
  assert.equal(view.answer.confidence, confidence); assert.equal(view.state, state);
  assert.equal(JSON.stringify(full.view), JSON.stringify(view));
  assert.equal(JSON.stringify(compact.view), JSON.stringify(view));
  assert.equal(JSON.stringify(projected.view), JSON.stringify(view));
  assert.deepEqual(called, counts);
  for (const count of counts) {
    const expected = core.fold(sequence.slice(0, count));
    assert.equal(JSON.stringify(full.prefixes.get(count)), JSON.stringify(expected));
    assert.equal(compact.prefixes.get(count).confidence, expected.answer.confidence);
    assert.deepEqual(projected.prefixes.get(count), { count, confidence:expected.answer.confidence });
  }
  const total = view.budget.total;
  full.prefixes.get(1).budget.total = 999;
  assert.equal(full.view.budget.total, total); assert.equal(compact.view.budget.total, total);
  assert.equal(JSON.stringify(events), input);
  return { view, compact };
}

test('confidence keeps its threshold, canonical history, finish and public prefix contracts', () => {
  const empty = history();
  assert.equal(check(empty.events, 'open').view.last_judge, null);
  for (const hint of [undefined, 'open', 'leaning', 'stronger']) {
    const h = history();
    h.add('judge_ran', { passed:false, summary:'failed note', ...(hint ? { confidence:hint } : {}) });
    assert.equal(check(h.events, hint || 'open').view.answer.text, 'failed note');
  }
  for (const n of [1, 2, 3, 4]) {
    const h = history(); h.add('judge_ran', { passed:false });
    for (let i = 0; i < n; i++) h.add('judge_ran', { passed:true, confidence:'stronger' });
    check(h.events, n < 3 ? 'leaning' : 'stronger');
  }
  const broken = history();
  for (let i = 0; i < 4; i++) broken.add('judge_ran', { passed:true });
  broken.add('judge_ran', { passed:false });
  const first = broken.add('judge_ran', { passed:true });
  broken.add('paused');
  const second = broken.add('judge_ran', { passed:true });
  broken.add('resumed');
  const third = broken.add('judge_ran', { passed:true });
  const b = check(broken.events, 'stronger');
  assert.deepEqual([first, second, third].map(n => b.compact.prefixes.get(n).confidence), ['leaning','leaning','stronger']);
  const ordinary = history(false);
  ordinary.add('judge_ran', { passed:true }); ordinary.add('judge_ran', { passed:false });
  ordinary.add('judge_ran', { passed:true, summary:'late answer' });
  const answered = check(ordinary.events, 'answered', 'done').view;
  assert.equal(answered.stop_reason, 'judge_passed'); assert.equal(answered.answer.text, 'late answer');
  for (const type of ['done', 'stopped']) {
    const h = history(false); h.add(type, {}, 'human:operator');
    const passes = [];
    for (let i = 0; i < 4; i++) passes.push(h.add('judge_ran', { passed:true }));
    const result = check(h.events, 'stronger', 'done');
    assert.equal(result.view.stop_reason, type === 'done' ? 'done_by_human' : 'stopped');
    assert.deepEqual(passes.map(n => result.compact.prefixes.get(n).confidence), ['leaning','leaning','stronger','stronger']);
  }
  const reset = history(); reset.add('judge_ran', { passed:true });
  reset.add('judge_set', { judge:'ignored' }, 'outsider');
  reset.add('judge_ran', { passed:true }); reset.add('judge_set', { judge:'replacement' });
  reset.add('judge_ran', { passed:true }); reset.add('judge_set', { judge:'replacement' }, 'human:operator');
  const r = check(reset.events, 'stronger').view;
  assert.equal(r.judge, 'replacement'); assert.equal(r.judge_due, true);
  assert.deepEqual(r.warnings.map(w => w.code), ['judge_set_not_owner']);
  const canonical = history();
  canonical.add('judge_ran', { passed:false });
  for (let i = 0; i < 3; i++) canonical.add('judge_ran', { passed:true });
  canonical.events[1].origin = 'z'; canonical.events[1].at = '2026-10-17T00:00:00.000000001Z';
  canonical.events[2].origin = 'z'; canonical.events[2].at = '2026-10-17T00:00:00.000000002Z';
  canonical.events[3].origin = 'a'; canonical.events[3].at = '2026-10-16T17:00:00.000000003-07:00';
  canonical.events[4].origin = 'a'; canonical.events[4].at = '2026-10-17T00:00:00.000000004Z';
  const expected = check(canonical.events, 'stronger').view;
  const duplicate = { ...canonical.events[4], data:{ passed:false } };
  const reversed = check([...canonical.events].reverse().concat(duplicate), 'stronger').view;
  assert.equal(JSON.stringify(reversed), JSON.stringify(expected));
  assert.equal(reversed.last_judge.at, '2026-10-17T00:00:00.000000004Z');
  const privateHistory = history();
  privateHistory.add('judge_ran', { passed:true, reading:1, summary:'PRIVATE_SUMMARY' });
  privateHistory.add('mission_proposed', { mission_id:'m0', member:'worker' });
  privateHistory.add('ask_opened', { ask_id:'a0', mission_id:'m0', question:'PRIVATE_QUESTION' });
  privateHistory.add('ask_answered', { ask_id:'a0', answer:'PRIVATE_ANSWER' }, 'human:operator');
  privateHistory.add('mission_ended', { mission_id:'m0', outcome:'kept', cost_usd:0 });
  for (let i = 1; i <= 2; i++) {
    privateHistory.add('judge_ran', { passed:true, reading:1, summary:'PRIVATE_SUMMARY' });
    privateHistory.add('mission_ended', { mission_id:'m'+i, outcome:'kept', cost_usd:0 });
  }
  privateHistory.add('judge_ran', { passed:true, reading:1 });
  check(privateHistory.events, 'stronger');
  const full = buildTrace(privateHistory.events, { redact:false }), redacted = buildTrace(privateHistory.events);
  assert.deepEqual(full.rows.map(row => row.state_before.confidence), ['leaning','leaning','stronger']);
  assert.ok(full.rows.every(row => row.reward === 0 && row.done === false));
  assert.ok(JSON.stringify(full).includes('PRIVATE_QUESTION'));
  assert.ok(!JSON.stringify(redacted).includes('PRIVATE_'));
  assert.equal(redacted.header.final.confidence, 'stronger');
  const sentinel = new Error('projector identity');
  assert.throws(() => core.foldWithPrefixes(empty.events, [1], () => { throw sentinel; }), e => e === sentinel);
  assert.deepEqual(core.fold([]), { error:'no_start' });
  assert.deepEqual(core.fold([{ ...empty.events[0], at:'invalid' }]), { error:'invalid_event' });
});

const PROBE = String.raw`
const assert = require('node:assert/strict'), path = require('node:path'), crypto = require('node:crypto');
const root = process.argv[1], counting = process.argv[2] === 'count';
const { buildTrace } = require(path.join(root, 'lib/campaign-trace'));
const key = crypto.randomBytes(32), cwd = process.cwd();
const env = () => Object.fromEntries(Object.keys(process.env).sort().map(k => [k, crypto.createHmac('sha256', key).update(process.env[k]).digest('hex')]));
const before = env(), results = [];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
function fixture(n) {
  const events = [];
  const add = (type, data) => {
    const seq = events.length + 1;
    events.push({ id:'confidence-'+seq, campaign_id:'cmp-confidence-streak', type,
      at:'2026-10-17T00:00:00Z', origin:'owned', seq, actor:type === 'judge_ran' ? 'judge' : 'owner', data });
  };
  add('campaign_started', { title:'Repeated passing checks', judge:'exit 0', budget:1, owner:'owner', standing:true });
  add('judge_ran', { passed:true, reading:1 });
  for (let i = 0; i < n; i++) { add('mission_ended', { mission_id:'m'+i, outcome:'kept', cost_usd:0 }); add('judge_ran', { passed:true, reading:1 }); }
  freeze(events); return events;
}
function observe(events, options) {
  const nativeDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'push'), native = nativeDescriptor.value;
  const rows = [], receivers = [], byReceiver = new WeakMap(), shape = ['passed','reading','summary','confidence','at'];
  let reads = 0, writes = 0, enabled = true, trace, failure, measured;
  Object.defineProperty(Array.prototype, 'push', { ...nativeDescriptor, value:function (...args) {
    const result = Reflect.apply(native, this, args), row = args[0];
    if (args.length !== 1 || !row || typeof row !== 'object') return result;
    const keys = Reflect.ownKeys(row);
    if (keys.length !== 5 || !keys.every((k, i) => k === shape[i])) return result;
    const descriptors = Object.getOwnPropertyDescriptors(row), passed = descriptors.passed;
    if (!('value' in passed) || typeof passed.value !== 'boolean' || !passed.writable || !passed.enumerable || !passed.configurable ||
      !shape.every(k => 'value' in descriptors[k])) throw new Error('unexpected private row descriptor');
    const index = this.length - 1;
    if (!Array.isArray(this) || result !== this.length || Object.getOwnPropertyDescriptor(this, String(index)).value !== row) throw new Error('native insertion identity');
    let receiver = byReceiver.get(this);
    if (!receiver) {
      if (receivers.length === 2) throw new Error('extra private receiver');
      const stack = new Error('private row creation').stack;
      if (!stack.includes(path.join(root, 'lib/campaign-core.js'))) throw new Error('unexpected private creation source');
      receiver = { array:this, insertions:0 }; byReceiver.set(this, receiver); Reflect.apply(native, receivers, [receiver]);
    }
    if (index !== receiver.insertions++) throw new Error('private insertion order');
    const retained = { value:passed.value };
    Reflect.apply(native, rows, [{ row, descriptors, retained }]);
    Object.defineProperty(row, 'passed', { enumerable:passed.enumerable, configurable:passed.configurable,
      get() { if (enabled) reads++; return retained.value; },
      set(value) { writes++; retained.value = value; } });
    return result;
  } });
  const restoreErrors = [];
  try { trace = buildTrace(events, options); }
  catch (error) { failure = error; }
  finally {
    measured = reads; enabled = false;
    try {
      for (const item of rows) {
        try { Object.defineProperty(item.row, 'passed', { ...item.descriptors.passed, value:item.retained.value }); }
        catch (error) { Reflect.apply(native, restoreErrors, [error.message]); }
      }
    } finally { Object.defineProperty(Array.prototype, 'push', nativeDescriptor); }
  }
  const facts = { reads:measured, writes, receivers:receivers.length, inserted:rows.length,
    lengths:receivers.map(r => r.array.length), insertions:receivers.map(r => r.insertions), creation_stacks:receivers.length };
  if (failure || restoreErrors.length) {
    console.error(JSON.stringify({ observer_stop:facts, restoreErrors, error:failure && failure.stack }));
    throw failure || new Error('row restoration failed');
  }
  try {
    assert.deepEqual(Object.getOwnPropertyDescriptor(Array.prototype, 'push'), nativeDescriptor);
    for (const item of rows) assert.deepEqual(Object.getOwnPropertyDescriptors(item.row), item.descriptors);
    assert.equal(writes, 0); assert.equal(receivers.length, 2);
  } catch (error) {
    console.error(JSON.stringify({ observer_stop:facts, error:error.stack })); throw error;
  }
  return { trace, facts };
}
let lastFacts = null;
try {
for (const n of [256, 512]) {
  const events = fixture(n), input = JSON.stringify(events);
  for (const redacted of [false, true]) {
    const options = redacted ? undefined : { redact:false };
    const observed = counting ? observe(events, options) : { trace:buildTrace(events, options), facts:null };
    const trace = observed.trace;
    lastFacts = { n, redacted, facts:observed.facts };
    assert.equal(trace.error, undefined); assert.equal(trace.rows.length, n);
    assert.equal(trace.header.final.state, 'resting'); assert.equal(trace.header.final.confidence, 'stronger');
    assert.equal(trace.header.redacted, redacted);
    assert.deepEqual(trace.rows.map(row => row.state_before.confidence), Array.from({ length:n }, (_, i) => i < 2 ? 'leaning' : 'stronger'));
    assert.ok(trace.rows.every(row => row.reward === 0 && row.done === false));
    assert.equal(JSON.stringify(events), input);
    if (counting) {
      assert.equal(observed.facts.inserted, 2 * (n + 1));
      assert.deepEqual(observed.facts.lengths, [n + 1, n + 1]);
      assert.deepEqual(observed.facts.insertions, [n + 1, n + 1]);
    }
    results.push({ n, redacted, input, trace, facts:observed.facts });
  }
}
assert.deepEqual(env(), before); assert.equal(process.cwd(), cwd);
console.log(JSON.stringify({ results, environment_preserved:true, cwd_preserved:true }));
} catch (error) {
  console.error(JSON.stringify({ partial:lastFacts, completed:results.length, error:error.stack })); throw error;
}
`;

test('real private passing-check reads stay bounded on long standing histories', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-'));
  const root = path.join(parent, 'work'), marker = path.join(parent, 'foreign');
  const cwd = process.cwd(), key = crypto.randomBytes(32);
  const env = () => Object.fromEntries(Object.keys(process.env).sort().map(k => [k, crypto.createHmac('sha256', key).update(process.env[k]).digest('hex')]));
  const before = env();
  t.after(() => {
    try { fs.rmSync(root, { recursive:true, force:true }); assert.equal(fs.readFileSync(marker, 'utf8'), 'retain'); }
    finally { fs.rmSync(parent, { recursive:true, force:true }); }
    assert.deepEqual(env(), before); assert.equal(process.cwd(), cwd);
  });
  fs.writeFileSync(marker, 'retain'); fs.mkdirSync(root);
  const reports = ['clean', 'count'].map(mode => {
    const child = spawnSync(process.execPath, ['-e', PROBE, path.resolve(__dirname, '..'), mode], {
      cwd:root, env:{ ...process.env }, encoding:'utf8', timeout:30000, maxBuffer:16*1024*1024,
    });
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  });
  assert.equal(reports[0].results.length, 4); assert.equal(reports[1].results.length, 4);
  const actual = [];
  for (let i = 0; i < 4; i++) {
    const clean = reports[0].results[i], observed = reports[1].results[i];
    assert.equal(clean.n, observed.n); assert.equal(clean.redacted, observed.redacted);
    assert.equal(JSON.stringify(clean.trace), JSON.stringify(observed.trace));
    assert.equal(clean.input, observed.input);
    assert.equal(observed.facts.writes, 0); assert.equal(observed.facts.receivers, 2);
    assert.equal(observed.facts.creation_stacks, 2); assert.equal(observed.facts.inserted, 2 * (observed.n + 1));
    actual.push({ n:observed.n, redacted:observed.redacted, ...observed.facts });
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
  t.diagnostic(JSON.stringify(actual));
  for (const row of actual) {
    assert.ok(row.reads > 0, 'actual private rows must be observed');
    assert.ok(row.reads <= 8 * row.n + 64, `${row.reads} actual private passed reads exceed ${8 * row.n + 64} for ${row.n} missions`);
  }
});

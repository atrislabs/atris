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

function history() {
  const events = [];
  const add = (type, data, at, actor = 'owner', origin = 'b') => {
    const seq = events.length + 1;
    const event = { id: `reset-case-${seq}`, campaign_id: 'cmp-reset-case', origin, seq, at, actor, type, data };
    events.push(event);
    return event;
  };
  add('campaign_started', { title: 'private goal', owner: 'owner', judge: 'node private-check.js', budget: 10, standing: true }, '2026-10-17T00:00:00Z');
  return { events, add };
}

test('accepted reset intervals use strict canonical positions and retain fault and privacy boundaries', () => {
  const beforeAt = '2026-10-17T00:00:01.000000001Z';
  const afterAt = '2026-10-17T00:00:04.000000001Z';
  for (const actor of ['owner', 'human:operator', 'outsider']) {
    for (const placement of ['before', 'lower-interior', 'upper-interior', 'after']) {
      const h = history();
      h.add('judge_ran', { passed: false, reading: 0.2 }, beforeAt, 'judge');
      h.add('mission_proposed', { mission_id: 'work', member: 'worker', objective: 'private work', verify: 'private verify' }, '2026-10-17T00:00:02Z');
      h.add('mission_ended', { mission_id: 'work', outcome: 'kept', cost_usd: 0.07 }, '2026-10-17T00:00:03Z');
      h.add('mission_ended', { mission_id: 'fault', outcome: 'fault', reason: 'private setup fault', cost_usd: 0.03 }, '2026-10-17T00:00:03.000000001Z');
      const lower = placement === 'before' || placement === 'lower-interior';
      // These offsets denote the same instants as the adjacent Z-stamped runs.
      const reset = h.add('judge_set', { judge: 'node private-check.js' },
        lower ? '2026-10-16T17:00:01.000000001-07:00' : '2026-10-16T17:00:04.000000001-07:00',
        actor, placement === 'before' || placement === 'upper-interior' ? 'a' : 'z');
      const interior = placement.includes('interior');
      if (interior) h.add('judge_set', { judge: 'node private-check.js' }, '2026-10-17T00:00:03.5Z', actor);
      h.add('judge_ran', { passed: false, reading: 0.8, summary: 'private result', output_tail: 'private output' }, afterAt, 'judge');
      const conflict = { ...reset, actor: actor === 'outsider' ? 'owner' : 'outsider' };
      const input = freeze([...h.events].reverse().concat(conflict));
      const bytes = JSON.stringify(input), full = buildTrace(input, { redact: false });
      const changed = interior && actor !== 'outsider';
      assert.equal(full.error, undefined);
      assert.equal(full.header.events, h.events.length, 'the first duplicate payload controls authorization');
      assert.equal(full.header.final.reading, 0.8);
      assert.equal(full.header.final.budget.spent, 0.1);
      const work = full.rows.find(row => row.action.mission_id === 'work');
      const fault = full.rows.find(row => row.action.mission_id === 'fault');
      assert.equal(work.reading_before, 0.2);
      assert.equal(work.reading_after, changed ? null : 0.8);
      assert.equal(work.reading_source, changed ? null : 'graded');
      assert.equal(work.reward, changed ? null : 0.6);
      assert.equal(work.judge_passed, changed ? null : false);
      assert.match(work.credit_note, changed ? /judge changed/ : /eligible/);
      assert.equal(fault.reward, null);
      assert.equal(fault.reading_after, changed ? null : 0.8);
      assert.match(fault.credit_note, /never ran/);
      assert.equal(fault.judge_output_tail, 'private output');
      const redacted = buildTrace(input);
      const facts = trace => trace.rows.map(row => [row.outcome, row.cost_usd, row.reading_before,
        row.reading_after, row.reading_source, row.reward, row.judge_passed, row.credit_note]);
      assert.deepEqual(facts(redacted), facts(full));
      assert.doesNotMatch(traceLines(redacted), /private/);
      assert.equal(traceLines(full), traceLines(buildTrace(h.events, { redact: false })));
      assert.equal(JSON.stringify(input), bytes);
    }
  }
  for (const missing of ['before', 'after']) {
    const h = history();
    if (missing !== 'before') h.add('judge_ran', { passed: false, reading: 0.2 }, beforeAt, 'judge');
    h.add('mission_ended', { mission_id: 'work', outcome: 'kept', cost_usd: 0 }, '2026-10-17T00:00:03Z');
    h.add('judge_set', { judge: 'node private-check.js' }, '2026-10-17T00:00:03.5Z');
    if (missing !== 'after') h.add('judge_ran', { passed: false, reading: 0.8 }, afterAt, 'judge');
    const row = buildTrace(freeze(h.events), { redact: false }).rows[0];
    assert.equal(row.reading_before, missing === 'before' ? null : 0.2);
    assert.equal(row.reading_after, missing === 'after' ? null : 0.8);
    assert.equal(row.reward, null);
    assert.match(row.credit_note, missing === 'before' ? /no judge run before/ : /no judge run after/);
  }
});

// An untimed observer of the actual retained reset array, not a substitute
// lookup. Only fixture construction and the unobserved call precede the hook.
const RESET_PROBE = String.raw`
const assert = require('node:assert/strict');
const { buildTrace } = require(require('node:path').join(process.argv[1], 'lib/campaign-trace'));
const n = 256, events = [];
function add(type, data, actor = 'owner') {
  const seq = events.length + 1;
  events.push({ id:'reset-work-'+seq, campaign_id:'cmp-reset-work', origin:'owned', seq,
    at:new Date(Date.UTC(2026,9,17)+(seq-1)*1000).toISOString(), actor, type, data });
}
add('campaign_started', { title:'Actual reset lookup work', owner:'owner', judge:'check', budget:10000, standing:true });
add('judge_ran', { passed:false, reading:0.2 }, 'judge');
for (let i=0; i<n; i++) {
  const mission_id = 'reset-m-'+i;
  add('judge_set', { judge:'check' });
  add('judge_ran', { passed:false, reading:0.2 }, 'judge');
  add('mission_started', { mission_id, member:'worker' });
  add('step', { mission_id, cost_usd:0 });
  add('mission_ended', { mission_id, outcome:'kept', cost_usd:0 });
  add('judge_ran', { passed:false, reading:0.2 }, 'judge');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
freeze(events);
const input = JSON.stringify(events), plain = buildTrace(events, { redact:false });
const expected = Array.from({ length:n }, (_,i) => 2+6*i);
const push = Array.prototype.push, slots = [], receivers = new Set();
let reads = 0, writes = 0, measured, observed;
Array.prototype.push = function (...items) {
  const index = this.length;
  const result = Reflect.apply(push, this, items);
  if (items.length === 1 && Number.isSafeInteger(items[0])) {
    receivers.add(this);
    const descriptor = Object.getOwnPropertyDescriptor(this, String(index));
    let value = descriptor.value;
    // Observer bookkeeping bypasses this hook, so it cannot identify itself.
    Reflect.apply(push, slots, [{ array:this, index, descriptor,
      restore() { Object.defineProperty(this.array, String(this.index), { ...this.descriptor, value }); } }]);
    Object.defineProperty(this, String(index), {
      enumerable:descriptor.enumerable, configurable:descriptor.configurable,
      get() { reads++; return value; },
      set(next) { writes++; value = next; },
    });
  }
  return result;
};
try { observed = buildTrace(events, { redact:false }); measured = reads; }
finally {
  Array.prototype.push = push;
  for (const slot of slots) slot.restore();
}
assert.equal(observed.error, undefined);
assert.equal(JSON.stringify(observed), JSON.stringify(plain));
assert.equal(JSON.stringify(events), input);
assert.equal(observed.header.final.state, 'resting');
assert.equal(observed.rows.length, n);
assert.equal(observed.header.batches, n);
assert.ok(observed.rows.every(row => row.reading_before === 0.2 && row.reading_after === 0.2 &&
  row.reward === 0 && row.judge_passed === false && row.credit_note === null));
assert.equal(receivers.size, 1, 'numeric push receiver is uniquely identified without source lines');
assert.equal(slots.length, n);
assert.equal(writes, 0);
assert.strictEqual(Array.prototype.push, push);
const positions = [...receivers][0];
assert.deepEqual(positions, expected);
for (const slot of slots) {
  const restored = Object.getOwnPropertyDescriptor(slot.array, String(slot.index));
  assert.deepEqual(restored, slot.descriptor);
  assert.equal(restored.value, expected[slot.index]);
  assert.equal(restored.writable && restored.enumerable && restored.configurable, true);
}
console.log(JSON.stringify({ missions:n, reset_positions:positions, reset_index_reads:measured, writes }));
`;

test('real reset interval lookup reads a bounded number of original numeric positions', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'crl-'));
  const root = path.join(parent, 'work'), marker = path.join(parent, 'foreign');
  t.after(() => {
    try {
      fs.rmSync(root, { recursive:true, force:true });
      assert.equal(fs.readFileSync(marker, 'utf8'), 'retain');
    } finally { fs.rmSync(parent, { recursive:true, force:true }); }
  });
  fs.writeFileSync(marker, 'retain');
  fs.mkdirSync(root);
  const child = spawnSync(process.execPath, ['-e', RESET_PROBE, path.resolve(__dirname, '..')], {
    cwd:root, env:{ ...process.env }, encoding:'utf8', timeout:30000, maxBuffer:1024*1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const measured = JSON.parse(child.stdout);
  t.diagnostic(JSON.stringify(measured));
  assert.equal(measured.reset_positions.length, measured.missions);
  assert.ok(measured.reset_index_reads > 0, 'the real reset lookup is observed');
  const bound = measured.missions * (2 * Math.ceil(Math.log2(measured.missions + 1)) + 4);
  assert.ok(measured.reset_index_reads <= bound,
    `${measured.reset_index_reads} actual reset reads exceeds the ${bound} operation bound`);
});

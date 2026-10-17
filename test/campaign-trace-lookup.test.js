'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrace, traceLines } = require('../lib/campaign-trace');

function history() {
  const events = [];
  const add = (type, data, actor = 'owner', at = '2026-10-17T00:00:00Z') => {
    const seq = events.length + 1;
    const event = { id: `lookup-${seq}`, campaign_id: 'cmp-lookup-boundaries',
      origin: 'owned', seq, at, type, actor, data };
    events.push(event);
    return event;
  };
  add('campaign_started', { title: 'private purpose', owner: 'owner',
    judge: 'node private-check.js', budget: 100, standing: true });
  const end = (mission_id, outcome = 'kept') =>
    add('mission_ended', { mission_id, outcome, cost_usd: 0 });
  return { events, add, end };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('judge neighbors use canonical nanosecond positions while start state keeps its earlier reading', () => {
  const h = history();
  const nano = n => `2026-10-17T00:00:00.00000000${n}Z`;
  h.add('judge_ran', { passed: false, reading: 0.1 }, 'judge', nano(1));
  h.add('mission_proposed', { mission_id: 'work' }, 'owner', nano(2));
  const before = h.add('judge_ran', { passed: false, reading: 0.35 }, 'judge', nano(3));
  h.add('mission_ended', { mission_id: 'work', outcome: 'kept', cost_usd: 0 }, 'owner', nano(4));
  h.add('judge_ran', { passed: false, reading: 0.8, summary: 'private first result' }, 'judge', nano(5));
  h.add('judge_ran', { passed: false, reading: 0.95 }, 'judge', nano(6));
  const input = freeze([...h.events].reverse().concat({ ...before, data: { passed: false, reading: 0.99 } }));
  const snapshot = JSON.stringify(input);
  const full = buildTrace(input, { redact: false });
  assert.equal(full.error, undefined);
  assert.equal(full.header.events, h.events.length, 'a conflicting later duplicate cannot replace its first payload');
  const row = full.rows[0];
  assert.equal(row.state_before.reading, 0.1);
  assert.equal(row.state_before.judge_runs, 1);
  assert.equal(row.reading_before, 0.35);
  assert.equal(row.reading_after, 0.8, 'the first later run wins, not the latest run');
  assert.equal(row.reward, 0.45);
  assert.equal(row.judge_summary, 'private first result');
  assert.equal(full.header.final.reading, 0.95);
  const redacted = buildTrace(input);
  assert.deepEqual(redacted.rows[0].state_before, row.state_before);
  assert.equal(redacted.rows[0].reward, row.reward);
  assert.doesNotMatch(traceLines(redacted), /private/);
  assert.equal(JSON.stringify(input), snapshot);
});

test('empty judge history and missing neighbors stay unknown at either array boundary', () => {
  const empty = history();
  assert.deepEqual(buildTrace(freeze([...empty.events])).rows, []);
  empty.end('without-runs');
  const absent = buildTrace(empty.events, { redact: false }).rows[0];
  assert.equal(absent.state_before.reading, null);
  assert.equal(absent.reading_before, null);
  assert.equal(absent.reading_after, null);
  assert.equal(absent.reward, null);

  const afterOnly = history();
  afterOnly.end('before-first-run');
  afterOnly.add('judge_ran', { passed: false, reading: 0.6 }, 'judge');
  const first = buildTrace(freeze(afterOnly.events), { redact: false }).rows[0];
  assert.equal(first.state_before.reading, null);
  assert.equal(first.reading_before, null);
  assert.equal(first.reading_after, 0.6);
  assert.equal(first.reward, null);
  assert.match(first.credit_note, /no judge run before/);

  const beforeOnly = history();
  beforeOnly.add('judge_ran', { passed: false, reading: 0.3 }, 'judge');
  beforeOnly.end('after-last-run');
  const last = buildTrace(freeze(beforeOnly.events), { redact: false }).rows[0];
  assert.equal(last.state_before.reading, 0.3);
  assert.equal(last.reading_before, 0.3);
  assert.equal(last.reading_after, null);
  assert.equal(last.reward, null);
  assert.equal(last.judge_passed, null);
  assert.match(last.credit_note, /no judge run after/);
});

test('only accepted resets strictly between the neighboring runs invalidate their comparison', () => {
  for (const actor of ['owner', 'human:operator', 'outsider']) {
    const h = history();
    h.add('judge_set', { judge: 'private-check' });
    h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
    h.end('earlier-work');
    h.add('judge_set', { judge: 'replacement-check' }, actor);
    h.add('judge_ran', { passed: true, reading: 0.8, output_tail: 'private output' }, 'judge');
    h.add('judge_set', { judge: 'later-check' });
    const row = buildTrace(freeze([...h.events].reverse()), { redact: false }).rows[0];
    assert.equal(row.reading_before, 0.2, actor);
    assert.equal(row.judge_output_tail, 'private output', 'reset comparisons still retain actual full diagnostic output');
    if (actor === 'outsider') {
      assert.equal(row.reading_after, 0.8);
      assert.equal(row.reward, 0.6);
      assert.equal(row.judge_passed, true);
    } else {
      assert.equal(row.reading_after, null);
      assert.equal(row.reward, null);
      assert.equal(row.judge_passed, null);
      assert.match(row.credit_note, /judge changed/);
    }
  }
});

test('neighbor batches keep faults out of the divisor and do not absorb adjacent judge intervals', () => {
  const h = history();
  h.add('judge_ran', { passed: false, reading: 0.2 }, 'judge');
  h.end('fault', 'fault');
  h.end('first-work');
  h.end('second-work', 'failed');
  h.add('judge_ran', { passed: false, reading: 0.8 }, 'judge');
  h.end('later-work');
  h.add('judge_ran', { passed: false, reading: 0.3 }, 'judge');
  const input = freeze(h.events);
  const snapshot = JSON.stringify(input);
  const full = buildTrace(input, { redact: false });
  assert.equal(full.header.batches, 2);
  assert.deepEqual(full.rows.map(row => row.batch), [
    { index: 1, size: 3 }, { index: 1, size: 3 }, { index: 1, size: 3 }, { index: 2, size: 1 },
  ]);
  assert.deepEqual(full.rows.map(row => row.reading_before), [0.2, 0.2, 0.2, 0.8]);
  assert.deepEqual(full.rows.map(row => row.reading_after), [0.8, 0.8, 0.8, 0.3]);
  assert.deepEqual(full.rows.map(row => row.reward), [null, 0.3, 0.3, -0.5]);
  assert.deepEqual(full.rows.map(row => row.state_before.judge_runs), [1, 1, 1, 2]);
  assert.deepEqual(buildTrace(input).rows.map(row => row.reward), [null, 0.3, 0.3, -0.5]);
  assert.equal(JSON.stringify(input), snapshot);
});

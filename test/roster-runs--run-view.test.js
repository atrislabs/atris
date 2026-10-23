'use strict';

// runView shapes one saved run for `atris engine roster --runs --json`: it
// always has a model key (null when the tool picked its own), and a run that
// did not land gets one plain reason line. It is pure object work, so it reads
// no env, no HOME, and no disk, and it never looks at the clock. Every run here
// is built by hand with fixed fields.

const { test } = require('node:test');
const assert = require('node:assert');

const { runView } = require('../lib/roster-runs');

const AT = '2026-10-20T14:00:00.000Z';

test('a landed run keeps its fields and gets no reason or model note', () => {
  const run = {
    at: AT,
    job: 'build',
    engine: 'codex',
    model: 'gpt-6.1-sol',
    outcome: 'landed',
    seconds: 120,
    detail: 'ignored for a landed run',
  };
  const view = runView(run);
  assert.deepStrictEqual(view, run);
  assert.strictEqual('reason' in view, false);
  assert.strictEqual('model_note' in view, false);
});

test('a run with no recorded model gets model null and a note saying why', () => {
  const view = runView({ at: AT, job: 'review', engine: 'claude', outcome: 'landed', seconds: 45 });
  assert.strictEqual(view.model, null);
  assert.strictEqual(view.model_note, 'the tool picked its own model; it was not recorded');
  assert.strictEqual(view.engine, 'claude');
  assert.strictEqual(view.seconds, 45);
});

test('a failed run with no detail gets the plain filler reason', () => {
  const view = runView({ at: AT, job: 'build', engine: 'devin', outcome: 'failed' });
  assert.strictEqual(view.reason, 'it failed and the tool gave no reason');
});

test('a stalled run with no detail says it did not finish in time', () => {
  const view = runView({ at: AT, job: 'build', engine: 'cursor', model: 'sonnet', outcome: 'stalled' });
  assert.strictEqual(view.reason, 'it did not finish in time');
  assert.strictEqual(view.model, 'sonnet');
  assert.strictEqual('model_note' in view, false);
});

test('a credit-out run with no detail says the engine hit its usage limit', () => {
  const view = runView({ at: AT, job: 'build', engine: 'grok', outcome: 'credit out' });
  assert.strictEqual(view.reason, 'the engine hit its usage limit');
});

test('a given detail becomes the reason, with whitespace collapsed', () => {
  const view = runView({
    at: AT,
    job: 'build',
    engine: 'codex',
    model: 'gpt-6.1-sol',
    outcome: 'failed',
    detail: '  tests   failed\n on the  merge  ',
  });
  assert.strictEqual(view.reason, 'tests failed on the merge');
});

test('a whitespace-only detail falls back to the filler reason', () => {
  const view = runView({ at: AT, job: 'build', engine: 'codex', outcome: 'stalled', detail: '   ' });
  assert.strictEqual(view.reason, 'it did not finish in time');
});

test('a detail longer than 240 characters is cut to 240 in the reason', () => {
  const long = 'x'.repeat(300);
  const view = runView({ at: AT, job: 'build', engine: 'codex', outcome: 'failed', detail: long });
  assert.strictEqual(view.reason.length, 240);
  assert.strictEqual(view.reason, long.slice(0, 240));
});

test('runView returns a new object and leaves the saved run untouched', () => {
  const run = { at: AT, job: 'build', engine: 'codex', outcome: 'failed' };
  const before = JSON.stringify(run);
  const view = runView(run);
  assert.notStrictEqual(view, run);
  assert.strictEqual(JSON.stringify(run), before);
  assert.strictEqual('model' in run, false);
  assert.strictEqual('reason' in run, false);
});

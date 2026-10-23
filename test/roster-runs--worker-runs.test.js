'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { workerRuns } = require('../lib/roster-runs');

test('workerRuns selects the job and engine in input order without a model pin', () => {
  const first = { job: 'build', engine: 'codex', model: 'model-a', outcome: 'landed' };
  const second = { job: 'executor', engine: 'codex', model: 'model-b', outcome: 'failed' };
  const third = { job: 'builder', engine: 'codex' };
  const runs = Object.freeze([
    Object.freeze(first),
    Object.freeze({ job: 'review', engine: 'codex' }),
    Object.freeze(second),
    Object.freeze({ job: 'build', engine: 'claude' }),
    Object.freeze(third),
  ]);

  const result = workerRuns(runs, { job: '  EXECUTOR  ', engine: ' codex ' });

  assert.deepStrictEqual(result, [first, second, third]);
  assert.strictEqual(result[0], first);
  assert.strictEqual(result[1], second);
  assert.strictEqual(result[2], third);
  assert.notStrictEqual(result, runs);
  assert.strictEqual(runs.length, 5);
});

test('workerRuns normalizes job separators and model whitespace and case', () => {
  const matching = { job: 'Small_Build', engine: 'codex', model: '  MODEL   A  ' };
  const runs = [
    matching,
    { job: 'small-build', engine: 'codex', model: 'model-b' },
    { job: 'small build', engine: 'codex' },
    { job: 'small build', engine: 'Codex', model: 'model a' },
    { job: 'build', engine: 'codex', model: 'model a' },
  ];

  assert.deepStrictEqual(workerRuns(runs, {
    job: ' small-build ', engine: 'codex', model: ' model a ',
  }), [matching]);
  assert.deepStrictEqual(workerRuns(runs, {
    job: 'small build', engine: 'codex', model: '   ',
  }), runs.slice(0, 3));
});

test('workerRuns returns an empty array for absent runs or no matching worker', () => {
  const worker = { job: 'review', engine: 'codex', model: 'model-a' };

  assert.deepStrictEqual(workerRuns(undefined, worker), []);
  assert.deepStrictEqual(workerRuns(null, worker), []);
  assert.deepStrictEqual(workerRuns([], worker), []);
  assert.deepStrictEqual(workerRuns([{ job: 'build', engine: 'codex' }], worker), []);
  assert.deepStrictEqual(workerRuns(), []);
});

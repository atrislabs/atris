'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachSuggestions } = require('../lib/roster-suggest');

// These paths use only supplied rows and runs, with no home or environment reads.
function job(jobName = 'build') {
  return {
    job: jobName,
    pick: { engine: 'codex' },
    workers: [
      { engine: 'codex', model: 'lead-model' },
      { engine: 'claude', model: 'challenger-model', effort: 'high' },
    ],
  };
}

function runs(engine, model, outcomes, jobName = 'build') {
  return outcomes.map((outcome, index) => ({
    at: `2024-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
    job: jobName,
    engine,
    model,
    outcome,
  }));
}

function qualifyingRuns(jobName = 'build') {
  return [
    ...runs('codex', 'lead-model', ['stalled', 'stalled', 'landed'], jobName),
    ...runs('claude', 'challenger-model', ['landed', 'landed'], jobName),
  ];
}

test('attaches complete suggestions in place and returns the number of eligible jobs', () => {
  const jobs = [job(), job('review'), job('search')];
  const history = [...qualifyingRuns(), ...qualifyingRuns('review')];
  const before = JSON.parse(JSON.stringify(history));

  assert.strictEqual(attachSuggestions(jobs, history), 2);
  assert.deepStrictEqual(jobs[0].suggestion, {
    job: 'build',
    days: 7,
    lead: { engine: 'codex', model: 'lead-model', runs: 3, landed: 1 },
    challenger: { engine: 'claude', model: 'challenger-model', runs: 2, landed: 2 },
    command: 'atris engine assign build --promote "claude code challenger-model high"',
    args: ['assign', 'build', '--promote', 'claude code challenger-model high'],
    text: 'codex lead-model stalled 2 of its last 3 runs; claude code challenger-model landed 2 of 2. to move claude code up: atris engine assign build --promote "claude code challenger-model high"',
  });
  assert.strictEqual(jobs[1].suggestion.job, 'review');
  assert.strictEqual(Object.hasOwn(jobs[2], 'suggestion'), false);
  assert.deepStrictEqual(history, before);
});

test('judges only the newest five non-credit runs and skips unavailable challengers', () => {
  const row = job();
  row.workers[1].status = 'skipped';
  row.workers.push({ engine: 'cursor' });
  const history = [
    ...runs('codex', 'lead-model', [
      'landed', 'landed', 'failed', 'failed', 'failed', 'landed', 'landed', 'credit out',
    ]),
    ...runs('claude', 'challenger-model', ['landed', 'landed', 'landed']),
    ...runs('cursor', '', ['landed', 'landed', 'credit out']),
  ];

  assert.strictEqual(attachSuggestions([row], history), 1);
  assert.deepStrictEqual(row.suggestion.lead, {
    engine: 'codex', model: 'lead-model', runs: 5, landed: 2,
  });
  assert.deepStrictEqual(row.suggestion.challenger, {
    engine: 'cursor', model: null, runs: 2, landed: 2,
  });
  assert.deepStrictEqual(row.suggestion.args, ['assign', 'build', '--promote', 'cursor']);
});

test('returns zero for missing jobs, empty history, and structurally ineligible rows', () => {
  assert.strictEqual(attachSuggestions(), 0);
  assert.strictEqual(attachSuggestions(null, qualifyingRuns()), 0);
  assert.strictEqual(attachSuggestions([], qualifyingRuns()), 0);

  const row = job();
  const before = JSON.parse(JSON.stringify(row));
  assert.strictEqual(attachSuggestions([row], []), 0);
  assert.strictEqual(attachSuggestions([row], undefined), 0);
  assert.deepStrictEqual(row, before);

  const ineligible = [null, {}, { ...job(), pick: null }, { ...job(), workers: [] }];
  assert.strictEqual(attachSuggestions(ineligible, qualifyingRuns()), 0);
  for (const entry of ineligible.filter(Boolean)) {
    assert.strictEqual(Object.hasOwn(entry, 'suggestion'), false);
  }
});

test('requires enough evidence and a lead success rate strictly below half', () => {
  const histories = [
    [
      ...runs('codex', 'lead-model', ['failed', 'failed']),
      ...runs('claude', 'challenger-model', ['landed', 'landed']),
    ],
    [
      ...runs('codex', 'lead-model', ['failed', 'failed', 'failed']),
      ...runs('claude', 'challenger-model', ['landed']),
    ],
    [
      ...runs('codex', 'lead-model', ['failed', 'failed', 'landed', 'landed']),
      ...runs('claude', 'challenger-model', ['landed', 'landed']),
    ],
  ];
  for (const history of histories) {
    const row = job();
    assert.strictEqual(attachSuggestions([row], history), 0);
    assert.strictEqual(Object.hasOwn(row, 'suggestion'), false);
  }
});

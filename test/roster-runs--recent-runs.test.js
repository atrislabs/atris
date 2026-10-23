'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { recentRuns } = require('../lib/roster-runs');

function run(id, at, job) {
  return { id, at, job, engine: 'cursor', outcome: 'landed' };
}

test('recent runs come back newest first and stop at twenty', () => {
  const runs = [];
  for (let day = 1; day <= 22; day += 1) {
    const stamp = String(day).padStart(2, '0');
    runs.push(run(`d${stamp}`, `2020-01-${stamp}T15:04:05.000Z`, 'build'));
  }

  const listed = recentRuns(runs);

  assert.strictEqual(listed.length, 20);
  assert.strictEqual(listed[0], runs[21]);
  assert.strictEqual(listed[19], runs[2]);
  assert.deepStrictEqual(listed.map((row) => row.id), [
    'd22', 'd21', 'd20', 'd19', 'd18', 'd17', 'd16', 'd15', 'd14', 'd13',
    'd12', 'd11', 'd10', 'd09', 'd08', 'd07', 'd06', 'd05', 'd04', 'd03',
  ]);
  assert.strictEqual(runs[0].id, 'd01');
});

test('a job filter uses the same names as the roster, and a tie keeps the later row', () => {
  const same = '2020-03-01T00:00:00.000Z';
  const runs = [
    run('old-review', '2020-02-01T00:00:00.000Z', 'review'),
    run('tie-early', same, 'build'),
    run('search', '2020-04-01T00:00:00.000Z', 'navigator'),
    run('tie-late', same, 'executor'),
    run('small', '2020-05-01T00:00:00.000Z', 'Small Build'),
    run('builder', '2020-03-15T12:00:00.000Z', 'builder'),
  ];

  assert.deepStrictEqual(
    recentRuns(runs, { job: 'executor', limit: 2 }).map((row) => row.id),
    ['builder', 'tie-late']
  );
  assert.deepStrictEqual(
    recentRuns(runs, { job: 'small-build' }).map((row) => row.id),
    ['small']
  );
  assert.deepStrictEqual(
    recentRuns(runs, { job: 'search' }).map((row) => row.id),
    ['search']
  );
  assert.deepStrictEqual(recentRuns(runs, { job: 'executor', limit: 0 }), []);
  assert.deepStrictEqual(
    recentRuns(runs, { job: '   ' }).map((row) => row.id),
    ['small', 'search', 'builder', 'tie-late', 'tie-early', 'old-review']
  );
});

test('missing input and unreadable times return a list and do not throw', () => {
  assert.deepStrictEqual(recentRuns(), []);
  assert.deepStrictEqual(recentRuns(null), []);
  assert.deepStrictEqual(recentRuns(undefined), []);
  assert.deepStrictEqual(recentRuns([]), []);
  assert.deepStrictEqual(recentRuns([
    run('kept', '2020-01-01T00:00:00.000Z', 'build'),
  ], { job: 'review' }), []);

  const bad = [
    run('first', 'not-a-date', 'build'),
    run('second', '', 'build'),
    { id: 'third', job: 'build', engine: 'cursor', outcome: 'landed' },
  ];
  assert.deepStrictEqual(recentRuns(bad).map((row) => row.id), ['third', 'second', 'first']);
});

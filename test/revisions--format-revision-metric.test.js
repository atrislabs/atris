'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { formatRevisionMetric } = require('../commands/revisions');

function makeMetric(overrides = {}) {
  return {
    rolling_7_days: {
      revision_count: 0,
      landed_changes: 0,
      clean_so_far: 0,
      still_observing: 0,
      ...(overrides.rolling_7_days || {}),
    },
    changes: overrides.changes,
  };
}

function savedRow(appended, date = '2026-01-15') {
  return { appended, row: { date } };
}

test('formats the three summary lines and the saved line for a clean week', () => {
  const metric = makeMetric({
    rolling_7_days: { revision_count: 0, landed_changes: 3, clean_so_far: 2, still_observing: 1 },
    changes: [],
  });

  const output = formatRevisionMetric(metric, savedRow(true));

  assert.strictEqual(output, [
    'revision signals in the last seven days: 0 across 3 atris-assisted landings.',
    'clean so far: 2. still observing: 1. the target is zero revisions.',
    'this is a same-file git signal, not proof of automatic landing or why a human changed the file.',
    'daily summary saved for 2026-01-15.',
  ].join('\n'));
});

test('uses the singular for exactly one landing and the plural for zero', () => {
  const one = formatRevisionMetric(
    makeMetric({ rolling_7_days: { landed_changes: 1 } }),
    savedRow(true),
  );
  assert.match(one, /across 1 atris-assisted landing\./);
  assert.doesNotMatch(one, /1 atris-assisted landings/);

  const none = formatRevisionMetric(makeMetric(), savedRow(true));
  assert.match(none, /across 0 atris-assisted landings\./);
});

test('lists only changes with revisions, with singular and plural wording', () => {
  const metric = makeMetric({
    rolling_7_days: { revision_count: 3, landed_changes: 3 },
    changes: [
      { subject: 'Fix login', revision_count: 1 },
      { subject: 'Clean change', revision_count: 0 },
      { subject: 'Rework billing', revision_count: 2 },
    ],
  });

  const lines = formatRevisionMetric(metric, savedRow(true)).split('\n');

  assert.deepStrictEqual(lines.slice(3, 5), [
    '"fix login": 1 possible revision.',
    '"rework billing": 2 possible revisions.',
  ]);
  assert.ok(!lines.some((line) => line.includes('clean change')));
  assert.strictEqual(lines.length, 6);
});

test('puts change lines before the saved line, which stays last', () => {
  const metric = makeMetric({
    changes: [{ subject: 'One', revision_count: 4 }],
  });

  const lines = formatRevisionMetric(metric, savedRow(true)).split('\n');

  assert.strictEqual(lines[3], '"one": 4 possible revisions.');
  assert.strictEqual(lines[lines.length - 1], 'daily summary saved for 2026-01-15.');
});

test('says the daily summary was already saved when nothing was appended', () => {
  const output = formatRevisionMetric(makeMetric({ changes: [] }), savedRow(false, '2026-02-03'));

  const lines = output.split('\n');
  assert.strictEqual(lines[lines.length - 1], 'daily summary for 2026-02-03 was already saved.');
  assert.ok(!output.includes('daily summary saved for'));
});

test('cleans subjects: lowercases, collapses whitespace, swaps em dashes for commas', () => {
  const metric = makeMetric({
    changes: [
      { subject: '  Ship   THE\tNew\nThing — Now  ', revision_count: 1 },
    ],
  });

  const output = formatRevisionMetric(metric, savedRow(true));

  assert.ok(output.includes('"ship the new thing , now": 1 possible revision.'));
  assert.ok(!output.includes('—'));
});

test('falls back to "untitled landing" when a subject is missing or empty', () => {
  const metric = makeMetric({
    changes: [
      { revision_count: 1 },
      { subject: '', revision_count: 2 },
      { subject: null, revision_count: 1 },
    ],
  });

  const lines = formatRevisionMetric(metric, savedRow(true)).split('\n');

  assert.deepStrictEqual(lines.slice(3, 6), [
    '"untitled landing": 1 possible revision.',
    '"untitled landing": 2 possible revisions.',
    '"untitled landing": 1 possible revision.',
  ]);
});

test('treats a missing changes list as empty instead of throwing', () => {
  const output = formatRevisionMetric(makeMetric({ changes: undefined }), savedRow(true));

  assert.strictEqual(output.split('\n').length, 4);
});

test('throws when the metric has no rolling summary or saved has no row', () => {
  assert.throws(() => formatRevisionMetric({}, savedRow(true)), TypeError);
  assert.throws(() => formatRevisionMetric(makeMetric(), { appended: true }), TypeError);
  assert.throws(() => formatRevisionMetric(makeMetric()), TypeError);
});

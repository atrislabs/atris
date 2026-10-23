'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendDailySummary } = require('../lib/revision-metric');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-daily-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function metric(generatedAt = '2024-02-29T12:00:00.000Z') {
  return {
    generated_at: generatedAt,
    source_ref: 'master',
    signal: { kind: 'proxy', source: 'git_history', revision_window_hours: 72 },
    rolling_7_days: {
      days: 7, landed_changes: 5, revision_count: 3, revised_changes: 2,
      clean_so_far: 3, mature_clean_changes: 1, still_observing: 2,
      excluded_state_only_landings: 4,
    },
  };
}

test('creates missing directories and persists the complete daily summary', (t) => {
  const root = temporaryRoot(t);
  const result = appendDailySummary(root, metric());
  const expected = {
    schema: 'atris.revision_metric.daily.v1', date: '2024-02-29', day_basis: 'utc',
    generated_at: '2024-02-29T12:00:00.000Z', source_ref: 'master', rolling_days: 7,
    revision_window_hours: 72, landed_changes: 5, revision_count: 3,
    revised_changes: 2, clean_so_far: 3, mature_clean_changes: 1,
    still_observing: 2, excluded_state_only_landings: 4,
    measurement_kind: 'proxy', signal_source: 'git_history',
  };
  assert.deepStrictEqual(result, {
    appended: true, row: expected,
    path: path.join('.atris', 'state', 'revision-metric.jsonl'),
  });
  assert.strictEqual(fs.readFileSync(path.join(root, result.path), 'utf8'),
    `${JSON.stringify(expected)}\n`);
});

test('deduplicates by UTC date and preserves the original row and file', (t) => {
  const root = temporaryRoot(t);
  const first = appendDailySummary(root, metric('2024-03-01T00:30:00+02:00'));
  assert.strictEqual(first.row.date, '2024-02-29');
  const file = path.join(root, first.path);
  const before = fs.readFileSync(file, 'utf8');
  const changed = metric('2024-02-29T23:59:00.000Z');
  changed.rolling_7_days.revision_count = 99;
  assert.deepStrictEqual(appendDailySummary(root, changed), {
    appended: false, row: first.row, path: first.path,
  });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  const next = appendDailySummary(root, metric('2024-03-01T00:00:00.000Z'));
  assert.strictEqual(next.appended, true);
  assert.strictEqual(next.row.date, '2024-03-01');
  assert.deepStrictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse),
    [first.row, next.row]);
});

test('handles empty and malformed history at a custom file path', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, 'custom', 'daily.jsonl');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '');
  const first = appendDailySummary(root, metric(), { file });
  assert.strictEqual(first.appended, true);
  assert.strictEqual(first.path, path.join('custom', 'daily.jsonl'));
  const prefix = 'not json\r\n\r\nnull\r\n';
  fs.writeFileSync(file, prefix);
  const result = appendDailySummary(root, metric(), { file });
  assert.strictEqual(result.appended, true);
  assert.deepStrictEqual(result.row, first.row);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), prefix + JSON.stringify(result.row) + '\n');
});

test('rejects an invalid date without creating a summary file', (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => appendDailySummary(root, metric('invalid-date')), RangeError);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

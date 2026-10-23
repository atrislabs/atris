'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendScorecard } = require('../lib/pulse');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-append-scorecard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('appendScorecard creates the state directory and appends rows without replacing earlier rows', (t) => {
  const root = temporaryRoot(t);
  const file = path.join(root, '.atris', 'state', 'scorecards.jsonl');
  const first = { ts: '2024-01-02T03:04:05.000Z', source: 'pulse', reward: 1 };
  const second = { ts: '2024-01-03T03:04:05.000Z', source: 'pulse', reward: -1 };

  assert.strictEqual(fs.existsSync(path.dirname(file)), false);
  assert.strictEqual(appendScorecard(root, first), file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(first) + '\n');
  assert.strictEqual(appendScorecard(root, second), file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'),
    JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n');
});

test('appendScorecard preserves escaped text, nested values, and empty rows as separate JSON lines', (t) => {
  const root = temporaryRoot(t);
  const row = { what: 'line one\n"line two" \\ café', files: [], details: { ok: false, reward: 0, task: null } };
  const file = appendScorecard(root, row);
  appendScorecard(root, {});
  appendScorecard(root, null);

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[3], '');
  assert.deepStrictEqual(lines.slice(0, -1).map((line) => JSON.parse(line)), [row, {}, null]);
});

test('appendScorecard rejects circular rows without corrupting existing scorecards', (t) => {
  const root = temporaryRoot(t);
  const row = { reward: 0 };
  const file = appendScorecard(root, row);
  const circular = {};
  circular.self = circular;

  assert.throws(() => appendScorecard(root, circular), TypeError);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(row) + '\n');
  assert.strictEqual(appendScorecard(root, {}), file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(row) + '\n{}\n');
});

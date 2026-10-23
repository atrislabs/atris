'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withBoard(records, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-print-board-'));
  const savedEnv = { ...process.env };
  const originalLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    if (records !== null) {
      const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
    const { printBoard } = require('../commands/wish');
    console.log = (...args) => output.push(args.join(' '));
    const code = printBoard(root);
    check(code, output);
  } finally {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('printBoard renders columns, current statuses, and the latest review including zero', () => {
  withBoard([
    { id: 'first', n: 1, ts: '2020-01-01T00:00:00Z', text: 'Fix login screen', status: 'needs_input', engine: 'local' },
    { id: 'second', n: 2, ts: '2020-01-02T00:00:00Z', text: 'Ship search', status: 'captured' },
    { id: 'second', status: 'complete', verify_status: 'passed', requested_engine: 'builder' },
    { kind: 'review', wish_id: 'second', review_score: 5 },
    { kind: 'review', wish_id: 'second', review_score: 0 },
  ], (code, output) => {
    assert.strictEqual(code, 0);
    assert.strictEqual(output.length, 1);
    const lines = output[0].split('\n');
    assert.deepStrictEqual(lines[0].split(/ {2,}/), ['wish', 'text', 'status', 'engine', 'verify_status', 'review']);
    assert.match(lines[1], /^-+(  -+){5}$/);
    assert.deepStrictEqual(lines.slice(2).map((line) => line.split(/ {2,}/)), [
      ['#1 fix login screen', 'Fix login screen', 'waiting on you', 'local', '-', '-'],
      ['#2 ship search', 'Ship search', 'done', 'builder', 'passed', 'reviewed/0'],
    ]);
  });
});

test('printBoard normalizes and truncates long text and supplies missing field fallbacks', () => {
  const longText = 'Repair   ' + 'x'.repeat(60) + '\nnow';
  withBoard([
    { id: 'long', n: 3, text: longText, status: 'captured' },
    { id: 'fallback', n: 4, task_text: 'Restore backup', status: 'unknown', latest_review: {} },
  ], (code, output) => {
    assert.strictEqual(code, 0);
    const rows = output[0].split('\n').slice(2).map((line) => line.split(/ {2,}/));
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0][1], 'Repair ' + 'x'.repeat(42) + '...');
    assert.strictEqual(rows[0][1].length, 52);
    assert.deepStrictEqual(rows[0].slice(2), ['new', '-', '-', '-']);
    assert.deepStrictEqual(rows[1], ['#4 restore backup', 'Restore backup', 'new', '-', '-', 'reviewed/n/a']);
  });
});

test('printBoard returns success with a plain empty message for missing or empty state', () => {
  for (const records of [null, []]) {
    withBoard(records, (code, output) => {
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, ['No wishes.']);
    });
  }
});

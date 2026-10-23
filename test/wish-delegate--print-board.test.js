'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { printBoard } = require('../lib/wish-delegate');

const savedEnv = {};
const tmpDirs = [];

test.before(() => {
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-home-'));
  tmpDirs.push(process.env.HOME);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-board-root-'));
  tmpDirs.push(root);
  return root;
}

function writeState(root, name, lines) {
  const dir = path.join(root, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  fs.writeFileSync(path.join(dir, name), `${body}\n`, 'utf8');
}

function capture(fn) {
  const printed = [];
  const original = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  let result;
  try {
    result = fn();
  } finally {
    console.log = original;
  }
  return { result, printed };
}

function pad(cells, widths) {
  return cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
}

test('printBoard says there are no wishes when nothing has been recorded', () => {
  const root = makeRoot();
  const { result, printed } = capture(() => printBoard(root));
  assert.strictEqual(result, 0);
  assert.deepStrictEqual(printed, ['No wishes.']);
});

test('printBoard defaults to the current folder when no root is passed', () => {
  const root = makeRoot();
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { result, printed } = capture(() => printBoard());
    assert.strictEqual(result, 0);
    assert.deepStrictEqual(printed, ['No wishes.']);
  } finally {
    process.chdir(previous);
  }
});

test('printBoard prints one aligned table with a plain status, engine, verify state and review per wish', () => {
  const root = makeRoot();
  const ids = {
    one: 'wish-2026-01-01-landing-aaaa1111',
    two: 'wish-2026-01-02-long-bbbb2222',
    three: 'wish-2026-01-03-notes-cccc3333',
    four: 'wish-2026-01-04-stuck-dddd4444',
    five: 'wish-2026-01-05-docs-eeee5555',
  };
  writeState(root, 'wishes.jsonl', [
    { id: ids.one, n: 1, ts: '2026-01-01T00:00:00.000Z', text: 'Make the landing page faster for visitors', status: 'needs_input', engine: 'codex', verify_status: 'pending' },
    { id: ids.two, n: 2, ts: '2026-01-02T00:00:00.000Z', text: 'Write   a   very long description of the quarterly onboarding checklist for new hires', status: 'complete', engine: 'devin', verify_status: 'passed' },
    { id: ids.three, ts: '2026-01-03T00:00:00.000Z', task_text: 'Sync notes', status: 'captured', requested_engine: 'grok' },
    { id: ids.four, n: 4, ts: '2026-01-04T00:00:00.000Z', text: 'Fix billing export', status: 'delegated', out_of_scope_parts: ['pricing'], engine: 'codex', verify_status: 'failed' },
    { id: ids.five, n: 5, ts: '2026-01-05T00:00:00.000Z', text: 'Tidy the docs', status: 'delegated' },
    { kind: 'review', wish_id: ids.two, ts: '2026-01-06T00:00:00.000Z', review_text: 'great', review_score: 5, reviewed_by: 'keshav' },
    { kind: 'review', wish_id: ids.two, ts: '2026-01-06T01:00:00.000Z', review_text: 'on second look, fine', review_score: 3, reviewed_by: 'keshav' },
    { kind: 'review', wish_id: ids.four, ts: '2026-01-06T02:00:00.000Z', review_text: 'no score given', reviewed_by: 'keshav' },
    { kind: 'review', wish_id: ids.five, ts: '2026-01-06T03:00:00.000Z', review_text: 'bad', review_score: 0, reviewed_by: 'keshav' },
  ]);

  const { result, printed } = capture(() => printBoard(root));

  assert.strictEqual(result, 0);
  assert.strictEqual(printed.length, 1, 'the whole board is one console.log call');

  const widths = [21, 52, 14, 6, 13, 12];
  const expected = [
    pad(['wish', 'text', 'status', 'engine', 'verify_status', 'review'], widths),
    widths.map((width) => '-'.repeat(width)).join('  '),
    pad(['#1 make landing page', 'Make the landing page faster for visitors', 'waiting on you', 'codex', 'pending', '-'], widths),
    pad(['#2 write very long', 'Write a very long description of the quarterly on...', 'done', 'devin', 'passed', 'reviewed/3'], widths),
    pad(['sync notes', 'Sync notes', 'new', 'grok', '-', '-'], widths),
    pad(['#4 fix billing export', 'Fix billing export', 'stuck', 'codex', 'failed', 'reviewed/n/a'], widths),
    pad(['#5 tidy docs', 'Tidy the docs', 'working', '-', '-', 'reviewed/0'], widths),
  ].join('\n');
  assert.strictEqual(printed[0], expected);

  // Long text is cut to 52 characters ending in "...", whitespace collapsed.
  const longRow = printed[0].split('\n')[3];
  assert.ok(longRow.includes('Write a very long description of the quarterly on...'));
  assert.ok(!longRow.includes('onboarding'));
  // No line carries trailing spaces.
  for (const line of printed[0].split('\n')) assert.strictEqual(line, line.trimEnd());
});

test('printBoard reads a wish status from its mission when the wish was delegated', () => {
  const root = makeRoot();
  writeState(root, 'wishes.jsonl', [
    { id: 'wish-m1', n: 1, ts: '2026-02-01T00:00:00.000Z', text: 'Ship search', status: 'delegated', mission_id: 'mission-stopped' },
    { id: 'wish-m2', n: 2, ts: '2026-02-02T00:00:00.000Z', text: 'Ship alerts', status: 'delegated', mission_id: 'mission-ready' },
    { id: 'wish-m3', n: 3, ts: '2026-02-03T00:00:00.000Z', text: 'Ship export', status: 'decomposed', mission_id: 'mission-complete' },
    { id: 'wish-m4', n: 4, ts: '2026-02-04T00:00:00.000Z', text: 'Ship sync', status: 'delegated', mission_id: 'mission-running' },
  ]);
  writeState(root, 'missions.jsonl', [
    { id: 'mission-stopped', status: 'stopped', created_at: '2026-02-01T00:00:00.000Z' },
    { id: 'mission-ready', status: 'ready', created_at: '2026-02-02T00:00:00.000Z' },
    { id: 'mission-complete', status: 'complete', created_at: '2026-02-03T00:00:00.000Z' },
    { id: 'mission-running', status: 'running', created_at: '2026-02-04T00:00:00.000Z' },
  ]);

  const { printed } = capture(() => printBoard(root));

  const rows = printed[0].split('\n').slice(2).map((line) => line.split(/ {2,}/));
  assert.deepStrictEqual(rows.map((cells) => [cells[0], cells[2]]), [
    ['#1 ship search', 'stuck'],
    ['#2 ship alerts', 'waiting on you'],
    ['#3 ship export', 'done'],
    ['#4 ship sync', 'working'],
  ]);
});

test('printBoard skips garbage lines and merges repeated records for the same wish', () => {
  const root = makeRoot();
  writeState(root, 'wishes.jsonl', [
    'this is not json',
    '',
    { note: 'no id, so this record is ignored' },
    { id: 'wish-merge', n: 7, ts: '2026-03-01T00:00:00.000Z', text: 'Rename the settings page', status: 'needs_input', engine: 'codex' },
    { id: 'wish-merge', ts: '2026-03-01T01:00:00.000Z', status: 'complete', verify_status: 'passed' },
  ]);

  const { result, printed } = capture(() => printBoard(root));

  assert.strictEqual(result, 0);
  const lines = printed[0].split('\n');
  assert.strictEqual(lines.length, 3, 'header, separator, and exactly one wish row');
  assert.deepStrictEqual(lines[2].split(/ {2,}/), [
    '#7 rename settings page',
    'Rename the settings page',
    'done',
    'codex',
    'passed',
    '-',
  ]);
});

test('printBoard fills engine, verify state and review with dashes when a wish has none', () => {
  const root = makeRoot();
  writeState(root, 'wishes.jsonl', [
    { id: 'wish-bare', n: 1, ts: '2026-04-01T00:00:00.000Z', text: 'Hi' },
  ]);

  const { printed } = capture(() => printBoard(root));

  const lines = printed[0].split('\n');
  assert.strictEqual(lines.length, 3);
  assert.deepStrictEqual(lines[2].split(/ {2,}/), ['#1 hi', 'Hi', 'new', '-', '-', '-']);
  // The separator is as wide as the header, column by column.
  assert.strictEqual(lines[1], ['-'.repeat(5), '-'.repeat(4), '-'.repeat(6), '-'.repeat(6), '-'.repeat(13), '-'.repeat(6)].join('  '));
});

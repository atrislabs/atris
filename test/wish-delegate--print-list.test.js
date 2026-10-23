'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-print-list-'));
const savedEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
for (const key of Object.keys(savedEnv)) delete process.env[key];
process.env.HOME = sandbox;
const { printList } = require('../lib/wish-delegate');
const now = Date.parse('2025-06-15T12:00:00.000Z');

after(() => {
  delete process.env.HOME;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function fixture(t, records) {
  const root = fs.mkdtempSync(path.join(sandbox, 'case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (records) {
    const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }
  return root;
}

function output(root, options = {}) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = printList(root, { now, ...options });
    return { code, lines };
  } finally {
    console.log = log;
  }
}

test('printList numbers wishes and renders statuses and review markers', (t) => {
  const root = fixture(t, [
    { id: 'waiting', n: 4, text: 'Please fix the login screen', status: 'needs_input', ts: '2025-06-01T00:00:00Z' },
    { id: 'done', n: 8, text: 'Ship search', status: 'complete', ts: '2025-06-14T12:00:00Z' },
    { kind: 'review', wish_id: 'done', ts: '2025-06-15T00:00:00Z', review_text: 'Looks good' },
    { id: 'new', n: 9, text: 'Add export', status: 'captured', ts: '2025-06-15T01:00:00Z' },
  ]);
  assert.deepStrictEqual(output(root), { code: 0, lines: [
    '1. #4 fix login screen - waiting on you',
    '2. #8 ship search - done [reviewed]',
    '3. #9 add export - new',
  ] });
});

test('printList includes the seven-day boundary and reveals resting wishes with all', (t) => {
  const root = fixture(t, [
    { id: 'older', n: 1, text: 'Old idea', status: 'captured', ts: '2025-06-08T11:59:59.999Z' },
    { id: 'boundary', n: 2, text: 'Boundary idea', status: 'captured', ts: '2025-06-08T12:00:00.000Z' },
  ]);
  assert.deepStrictEqual(output(root), { code: 0, lines: [
    '1. #2 boundary idea - new',
    '1 older wish is resting. See it with atris wish list --all',
  ] });
  assert.deepStrictEqual(output(root, { all: true }), { code: 0, lines: [
    '1. #1 old idea - new',
    '2. #2 boundary idea - new',
  ] });
});

test('printList asks for review exactly one day after completion', (t) => {
  const root = fixture(t, [
    { id: 'stale', n: 1, text: 'Ship reports', status: 'complete', ts: '2025-06-14T12:00:00.000Z' },
    { id: 'fresh', n: 2, text: 'Ship charts', status: 'complete', ts: '2025-06-14T12:00:00.001Z' },
  ]);
  assert.deepStrictEqual(output(root), { code: 0, lines: [
    '1. #1 ship reports - done, needs your review',
    '2. #2 ship charts - done',
  ] });
});

test('printList reports no open wishes for missing storage or closed records', (t) => {
  assert.deepStrictEqual(output(fixture(t)), { code: 0, lines: ['No open wishes.'] });
  const root = fixture(t, [
    { id: 'closed', text: 'Finished idea', status: 'closed', ts: '2025-06-15T00:00:00Z' },
  ]);
  assert.deepStrictEqual(output(root), { code: 0, lines: ['No open wishes.'] });
});

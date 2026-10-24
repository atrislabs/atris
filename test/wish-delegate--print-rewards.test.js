'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printRewards } = require('../lib/wish-delegate');
const { BACKEND_ROOT_HINT } = require('../utils/backend-root');

const BACKEND_ENV_KEYS = ['ATRIS_BACKEND_ROOT', 'ATRIS_BACKEND_DIR', 'ATRIS_BACKEND_INSTALL_SIBLING'];

// Runs fn inside a fresh temp root with backend env cleared, a private HOME,
// and console output captured. Everything is restored afterwards.
function sandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-print-rewards-'));
  const saved = { HOME: process.env.HOME };
  for (const key of BACKEND_ENV_KEYS) saved[key] = process.env[key];
  for (const key of BACKEND_ENV_KEYS) delete process.env[key];
  process.env.HOME = path.join(root, 'home');
  const out = [];
  const err = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    return fn({ root, out, err });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeWishEvents(root, rows) {
  writeJsonl(path.join(root, '.atris', 'state', 'wishes.jsonl'), rows);
}

function makeBackend(root) {
  const backend = path.join(root, 'backend');
  fs.mkdirSync(backend, { recursive: true });
  process.env.ATRIS_BACKEND_ROOT = backend;
  return backend;
}

function review(wishId, ts, score, text = 'looks right') {
  return { kind: 'review', wish_id: wishId, ts, review_text: text, review_score: score, reviewed_by: 'tester' };
}

test('printRewards counts reviews, averages scores, and counts reward rows', () => {
  const result = sandbox(({ root, out, err }) => {
    makeBackend(root);
    writeWishEvents(root, [
      { id: 'wish-a', ts: '2026-10-01T09:00:00.000Z', text: 'first wish', status: 'delegated' },
      review('wish-a', '2026-10-01T10:00:00.000Z', 4, 'good, ship it'),
      { kind: 'steer', wish_id: 'wish-a', ts: '2026-10-01T10:30:00.000Z', note: 'focus' },
      review('wish-b', '2026-10-02T11:30:00.000Z', 5, 'great'),
    ]);
    writeJsonl(path.join(root, 'backend', '.atris', 'state', 'scorecards.jsonl'), [
      { source: 'wish_review', feedback: 'ok', score: 4 },
      { source: 'other', feedback: 'a wish_review note' },
      { source: 'other', feedback: 'unrelated' },
    ]);
    const code = printRewards(root);
    assert.deepStrictEqual(err, []);
    assert.deepStrictEqual(out, [
      'reviews count: 2',
      'avg score: 4.50',
      'last 5 review lines:',
      '- 2026-10-01 score=4 wish-a good, ship it',
      '- 2026-10-02 score=5 wish-b great',
      'reward rows found: 2',
    ]);
    return code;
  });
  assert.strictEqual(result, 0);
});

test('printRewards shows only the last five reviews and prints a whole-number average', () => {
  sandbox(({ root, out }) => {
    makeBackend(root);
    const events = [];
    for (let day = 1; day <= 7; day += 1) {
      events.push(review(`wish-${day}`, `2026-10-0${day}T12:00:00.000Z`, day, `note ${day}`));
    }
    writeWishEvents(root, events);
    printRewards(root);
    assert.deepStrictEqual(out, [
      'reviews count: 7',
      'avg score: 4',
      'last 5 review lines:',
      '- 2026-10-03 score=3 wish-3 note 3',
      '- 2026-10-04 score=4 wish-4 note 4',
      '- 2026-10-05 score=5 wish-5 note 5',
      '- 2026-10-06 score=6 wish-6 note 6',
      '- 2026-10-07 score=7 wish-7 note 7',
      'reward rows found: 0',
    ]);
  });
});

test('printRewards handles reviews with no score, no timestamp, and long text', () => {
  sandbox(({ root, out }) => {
    makeBackend(root);
    writeWishEvents(root, [
      { kind: 'review', wish_id: 'wish-no-score', review_text: 'no score', review_score: null },
      review('wish-long', '2026-10-05T08:00:00.000Z', 3, 'a'.repeat(100)),
    ]);
    printRewards(root);
    assert.deepStrictEqual(out, [
      'reviews count: 2',
      'avg score: 3',
      'last 5 review lines:',
      '- unknown-date score=n/a wish-no-score no score',
      `- 2026-10-05 score=3 wish-long ${'a'.repeat(77)}...`,
      'reward rows found: 0',
    ]);
  });
});

test('printRewards with no wishes and no backend data prints zeros and no hint', () => {
  sandbox(({ root, out, err }) => {
    makeBackend(root);
    printRewards(root);
    assert.deepStrictEqual(err, []);
    assert.deepStrictEqual(out, [
      'reviews count: 0',
      'avg score: n/a',
      'last 5 review lines:',
      '- none',
      'reward rows found: 0',
    ]);
  });
});

test('printRewards without a backend prints the hint and still counts reviews', () => {
  sandbox(({ root, out, err }) => {
    process.env.ATRIS_BACKEND_ROOT = path.join(root, 'missing-backend');
    writeWishEvents(root, [review('wish-a', '2026-10-01T10:00:00.000Z', 2)]);
    printRewards(root);
    assert.deepStrictEqual(err, [BACKEND_ROOT_HINT]);
    assert.deepStrictEqual(out, [
      'reviews count: 1',
      'avg score: 2',
      'last 5 review lines:',
      '- 2026-10-01 score=2 wish-a looks right',
      'reward rows found: 0',
    ]);
  });
});

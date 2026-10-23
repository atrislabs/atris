'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printWishStats, verifierPassed } = require('../lib/wish-stats');

const WHEN = new Date(2026, 5, 15, 12, 0, 0);
const NOW = WHEN.getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysBefore(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-stats-lib-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function captureLog(fn) {
  const lines = [];
  const previous = console.log;
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { status: fn(), output: lines.join('\n') };
  } finally {
    console.log = previous;
  }
}

function appendEvent(root, event) {
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function writeRunFile(root, name, contents) {
  const file = path.join(root, 'atris', 'runs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (contents === null) {
    fs.mkdirSync(file);
    return;
  }
  fs.writeFileSync(file, contents);
}

function receipt(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function seedWorkspace(root) {
  appendEvent(root, {
    id: 'wish-complete',
    ts: isoDaysBefore(1),
    text: 'ship the counter',
    status: 'complete',
  });
  appendEvent(root, {
    id: 'wish-open',
    ts: isoDaysBefore(2),
    text: 'leave this open',
    status: 'captured',
  });
  appendEvent(root, {
    id: 'wish-verified',
    ts: isoDaysBefore(3),
    text: 'verify the counter',
    verify_status: 'verified',
  });
  appendEvent(root, {
    id: 'wish-prior',
    ts: isoDaysBefore(10),
    text: 'ship last week',
    status: 'completed',
  });
  appendEvent(root, {
    id: 'wish-boundary',
    ts: new Date(NOW).toISOString(),
    text: 'exactly now stays out of this week',
    status: 'complete',
  });
  appendEvent(root, {
    kind: 'review',
    wish_id: 'wish-complete',
    ts: isoDaysBefore(1),
    review_text: 'zero still counts',
    review_score: 0,
  });
  appendEvent(root, {
    kind: 'review',
    wish_id: 'wish-open',
    ts: isoDaysBefore(2),
    review_text: 'high',
    review_score: 5,
  });
  appendEvent(root, {
    kind: 'review',
    wish_id: 'wish-verified',
    ts: isoDaysBefore(3),
    review_text: 'blank score',
    review_score: '',
  });
  appendEvent(root, {
    kind: 'review',
    wish_id: 'wish-verified',
    ts: isoDaysBefore(3),
    review_text: 'not a number',
    review_score: 'nope',
  });
  appendEvent(root, {
    kind: 'review',
    wish_id: 'wish-prior',
    ts: isoDaysBefore(10),
    review_text: 'prior',
    review_score: 2,
  });

  writeRunFile(root, 'mission-haiku-pass.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: 'Haiku' }, verifier_result: { passed: true } },
  }));
  writeRunFile(root, 'mission-haiku-fail.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: {
      frozen: { runner: 'haiku' },
      tick: { verifier_passed: false },
      passed: true,
    },
  }));
  writeRunFile(root, 'mission-haiku-noschema.json', receipt({
    result: { frozen: { runner: 'haiku' }, passed: true },
  }));
  writeRunFile(root, 'mission-codex-pass.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: ' Codex ' }, passed: true },
  }));
  writeRunFile(root, 'mission-opus-status.json', receipt({
    schema: 'atris.mission_receipt.v1',
    verifier_result: { status: 0 },
    result: { frozen: { runner: 'opus' } },
  }));
  writeRunFile(root, 'mission-cursor-fail.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: 'cursor' }, verifier_result: { status: 1 } },
  }));
  writeRunFile(root, 'mission-wrong-schema.json', receipt({
    schema: 'atris.other',
    result: { frozen: { runner: 'haiku' }, passed: true },
  }));
  writeRunFile(root, 'mission-blank-runner.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: '   ' }, passed: true },
  }));
  writeRunFile(root, 'mission-broken.json', '{');
  writeRunFile(root, 'mission-skip.txt', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: 'haiku' }, passed: true },
  }));
  writeRunFile(root, 'readme.json', receipt({
    schema: 'atris.mission_receipt.v1',
    result: { frozen: { runner: 'haiku' }, passed: true },
  }));
  writeRunFile(root, 'mission-folder.json', null);
}

test('verifierPassed stops at the first boolean and otherwise treats status zero as passed', () => {
  assert.strictEqual(verifierPassed(null), true);
  assert.strictEqual(verifierPassed(undefined), false);
  assert.strictEqual(verifierPassed({}), false);
  assert.strictEqual(verifierPassed({
    verifier_result: { passed: false, status: 0 },
    result: { passed: true, tick: { verifier_passed: true } },
  }), false);
  assert.strictEqual(verifierPassed({
    result: { verifier_result: { passed: true } },
  }), true);
  assert.strictEqual(verifierPassed({
    result: { tick: { verifier_passed: false }, passed: true },
  }), false);
  assert.strictEqual(verifierPassed({
    result: { passed: true },
  }), true);
  assert.strictEqual(verifierPassed({
    verifier_result: { status: '0' },
  }), true);
  assert.strictEqual(verifierPassed({
    result: { verifier_result: { status: 1 } },
  }), false);
  assert.strictEqual(verifierPassed({
    verifier_result: { status: 0.5 },
  }), false);
});

test('printWishStats counts wishes, scores, and runner receipts from a temp root', () => {
  const populated = [
    'wishes this week: 3, prior week 1',
    'reviews per shipped wish: 1.25',
    'average score trend: 2.50 this week, 2 prior week',
    'haiku pass rate: 2/3, all other runners 2/3',
  ].join('\n');

  withRoot((root) => {
    seedWorkspace(root);
    const logged = captureLog(() => printWishStats(root, { now: NOW }));
    assert.strictEqual(logged.status, 0);
    assert.strictEqual(logged.output, populated);

    const journal = path.join(root, 'atris', 'logs', '2026', '2026-06-15.md');
    assert.strictEqual(fs.existsSync(journal), false);

    const written = captureLog(() => printWishStats(root, { now: NOW, write: true, date: WHEN }));
    assert.strictEqual(written.status, 0);
    assert.strictEqual(written.output, populated);
    const block = `## Wish stats\n${populated}\n`;
    assert.strictEqual(fs.readFileSync(journal, 'utf8'), block);

    const again = captureLog(() => printWishStats(root, { now: NOW, write: true, date: WHEN }));
    assert.strictEqual(again.status, 0);
    assert.strictEqual(fs.readFileSync(journal, 'utf8'), `${block}\n\n${block}`);
  });

  const empty = [
    'wishes this week: 0, prior week 0',
    'reviews per shipped wish: 0.00',
    'average score trend: n/a this week, n/a prior week',
    'haiku pass rate: 0/0, all other runners 0/0',
  ].join('\n');

  withRoot((root) => {
    const logged = captureLog(() => printWishStats(root, { now: NOW }));
    assert.strictEqual(logged.status, 0);
    assert.strictEqual(logged.output, empty);
  });
});

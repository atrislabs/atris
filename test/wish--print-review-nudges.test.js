const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printReviewNudges } = require('../commands/wish');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-nudges-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function appendWishEvent(dir, event) {
  const file = path.join(dir, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function captureConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = fn();
    return { code, lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('prints nothing and returns 0 when there are no wishes', () => {
  const dir = makeTempDir();
  try {
    const { code, lines } = captureConsole(() => printReviewNudges(dir));
    assert.equal(code, 0);
    assert.deepEqual(lines, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('nudges a shipped unreviewed wish and skips wishes still in flight', () => {
  const dir = makeTempDir();
  try {
    // No timestamp fields: shipped time is unparseable, so the wish can never
    // go stale and this stays true no matter when the test runs.
    appendWishEvent(dir, {
      id: 'wish-fresh-one',
      n: 1,
      text: 'fix the login bug',
      status: 'complete',
    });
    appendWishEvent(dir, {
      id: 'wish-wip-two',
      n: 2,
      text: 'add dark mode',
      status: 'delegated',
    });
    const { code, lines } = captureConsole(() => printReviewNudges(dir));
    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'Wishes ready for review:',
      '- #1 fix login bug: atris wish review 1 "<one sentence>"',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('skips reviewed and long-stale shipped wishes', () => {
  const dir = makeTempDir();
  try {
    appendWishEvent(dir, {
      id: 'wish-done-three',
      n: 3,
      text: 'ship the docs page',
      status: 'complete',
    });
    appendWishEvent(dir, {
      kind: 'review',
      wish_id: 'wish-done-three',
      ts: '2025-01-01T00:00:00.000Z',
      review_text: 'works as asked',
      review_score: 1,
    });
    // Fixed far-past completion date: always more than a day old, so stale.
    appendWishEvent(dir, {
      id: 'wish-stale-four',
      n: 4,
      text: 'tidy the metrics job',
      status: 'complete',
      completed_at: '2000-01-01T00:00:00.000Z',
    });
    const { code, lines } = captureConsole(() => printReviewNudges(dir));
    assert.equal(code, 0);
    assert.deepEqual(lines, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('nudges a wish whose verify gate passed even when status is not complete', () => {
  const dir = makeTempDir();
  try {
    appendWishEvent(dir, {
      id: 'wish-verified-five',
      n: 5,
      text: 'repair the flaky test',
      status: 'delegated',
      verify_status: 'passed',
    });
    const { code, lines } = captureConsole(() => printReviewNudges(dir));
    assert.equal(code, 0);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], 'Wishes ready for review:');
    assert.ok(lines[1].includes('atris wish review 5 "<one sentence>"'));
    assert.ok(lines[1].startsWith('- #5 '));
  } finally {
    cleanupTempDir(dir);
  }
});

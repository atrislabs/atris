'use strict';

// improveWishes copies review events newer than a saved cursor into the wish
// lessons inbox, then moves the cursor to the newest one it copied. Every test
// runs in a fresh temp folder with fixed ISO timestamps, so the clock and the
// local time zone never change the result.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { improveWishes } = require('../lib/wish-store');

const INBOX_HEADING = '## Review inbox (raw, distill me)';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wish-improve-'));
}

function stateFile(root) {
  return path.join(root, '.atris', 'state', 'wishes.jsonl');
}

function cursorFile(root) {
  return path.join(root, '.atris', 'state', 'wish-improve.cursor.json');
}

function lessonsFile(root) {
  return path.join(root, '.claude', 'skills', 'wish', 'LESSONS.md');
}

function writeWishState(root, events) {
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

function appendWishState(root, event) {
  fs.appendFileSync(stateFile(root), JSON.stringify(event) + '\n', 'utf8');
}

function readLessons(root) {
  return fs.readFileSync(lessonsFile(root), 'utf8');
}

function readCursor(root) {
  return JSON.parse(fs.readFileSync(cursorFile(root), 'utf8'));
}

function inboxLinesFor(root, wishId) {
  return readLessons(root).split('\n').filter((line) => line.includes(` | ${wishId} | `));
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('copies review events into the inbox and moves the cursor to the newest one', () => {
  const root = makeRoot();
  try {
    writeWishState(root, [
      { id: 'wish-a', ts: '2026-01-01T09:00:00.000Z', text: 'speed up sync' },
      { kind: 'steer', wish_id: 'wish-a', ts: '2026-01-02T09:00:00.000Z', note: 'focus on retries' },
      { kind: 'review', wish_id: 'wish-a', ts: '2026-01-03T10:00:00.000Z', review_score: 1, review_text: 'Clear result, one proof', reviewed_by: 'codex' },
      { kind: 'review', wish_id: 'wish-a', ts: '2026-01-04T10:00:00.000Z', review_score: -1, review_text: 'Shipped without a test', reviewed_by: 'opus' },
    ]);

    assert.equal(improveWishes(root, { quiet: true }), 0);

    const text = readLessons(root);
    assert.equal(
      text.slice(text.indexOf(INBOX_HEADING)),
      [
        INBOX_HEADING,
        '- 2026-01-03T10:00:00.000Z | wish-a | score 1 | Clear result, one proof (by codex)',
        '- 2026-01-04T10:00:00.000Z | wish-a | score -1 | Shipped without a test (by opus)',
        '',
      ].join('\n'),
    );
    assert.ok(!text.includes('speed up sync'), 'a plain wish record is not a review');
    assert.ok(!text.includes('focus on retries'), 'a steer is not a review');
    assert.equal(readCursor(root).last_ts, '2026-01-04T10:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a second run only copies reviews newer than the cursor', () => {
  const root = makeRoot();
  try {
    writeWishState(root, [
      { kind: 'review', wish_id: 'wish-b', ts: '2026-02-01T10:00:00.000Z', review_score: 1, review_text: 'first pass', reviewed_by: 'codex' },
    ]);
    assert.equal(improveWishes(root, { quiet: true }), 0);

    appendWishState(root, { kind: 'review', wish_id: 'wish-b', ts: '2026-02-02T10:00:00.000Z', review_score: -1, review_text: 'regressed', reviewed_by: 'opus' });
    const ingestLog = captureLog(() => assert.equal(improveWishes(root), 0));
    assert.deepEqual(ingestLog, [
      `wish improve: ingested 1 review (avg score -1.00, 1 negative) into ${path.join('.claude', 'skills', 'wish', 'LESSONS.md')}.`,
    ]);
    assert.deepEqual(inboxLinesFor(root, 'wish-b'), [
      '- 2026-02-01T10:00:00.000Z | wish-b | score 1 | first pass (by codex)',
      '- 2026-02-02T10:00:00.000Z | wish-b | score -1 | regressed (by opus)',
    ]);

    const before = readLessons(root);
    const idleLog = captureLog(() => assert.equal(improveWishes(root), 0));
    assert.deepEqual(idleLog, ['wish improve: nothing new.']);
    assert.equal(readLessons(root), before);
    assert.equal(readCursor(root).last_ts, '2026-02-02T10:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a review with no score, reviewer, or wish id gets placeholder values', () => {
  const root = makeRoot();
  try {
    writeWishState(root, [
      { kind: 'review', ts: '2026-03-01T00:00:00.000Z', review_text: '  padded note  ' },
    ]);

    const log = captureLog(() => assert.equal(improveWishes(root), 0));

    assert.deepEqual(inboxLinesFor(root, 'unknown-wish'), [
      '- 2026-03-01T00:00:00.000Z | unknown-wish | score none | padded note (by unknown)',
    ]);
    assert.deepEqual(log, [
      `wish improve: ingested 1 review (avg score n/a, 0 negative) into ${path.join('.claude', 'skills', 'wish', 'LESSONS.md')}.`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty folder or a state file with no reviews writes nothing', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(captureLog(() => assert.equal(improveWishes(root), 0)), ['wish improve: nothing new.']);
    assert.equal(fs.existsSync(lessonsFile(root)), false);
    assert.equal(fs.existsSync(cursorFile(root)), false);

    writeWishState(root, [
      { id: 'wish-c', ts: '2026-04-01T09:00:00.000Z', text: 'no reviews here' },
      { kind: 'steer', wish_id: 'wish-c', ts: '2026-04-02T09:00:00.000Z', note: 'still no review' },
    ]);
    assert.deepEqual(captureLog(() => assert.equal(improveWishes(root), 0)), ['wish improve: nothing new.']);
    assert.equal(fs.existsSync(lessonsFile(root)), false);
    assert.equal(fs.existsSync(cursorFile(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skips a torn line, re-reads everything after a corrupt cursor, and keeps existing lessons', () => {
  const root = makeRoot();
  try {
    const good = { kind: 'review', wish_id: 'wish-d', review_score: 1, reviewed_by: 'codex' };
    fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
    fs.writeFileSync(stateFile(root), [
      JSON.stringify({ ...good, ts: '2026-05-01T00:00:00.000Z', review_text: 'kept one' }),
      '{"kind":"review","wish_id":',
      JSON.stringify({ ...good, ts: '2026-05-02T00:00:00.000Z', review_text: 'kept two' }),
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(cursorFile(root), 'not json', 'utf8');
    fs.mkdirSync(path.dirname(lessonsFile(root)), { recursive: true });
    fs.writeFileSync(lessonsFile(root), [
      '# Wish lessons',
      '',
      '## Lessons',
      '',
      '- keep proofs falsifiable',
      '',
      INBOX_HEADING,
      '',
    ].join('\n'), 'utf8');

    assert.equal(improveWishes(root, { quiet: true }), 0);

    assert.ok(readLessons(root).includes('- keep proofs falsifiable'));
    assert.deepEqual(inboxLinesFor(root, 'wish-d'), [
      '- 2026-05-01T00:00:00.000Z | wish-d | score 1 | kept one (by codex)',
      '- 2026-05-02T00:00:00.000Z | wish-d | score 1 | kept two (by codex)',
    ]);
    assert.equal(readCursor(root).last_ts, '2026-05-02T00:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

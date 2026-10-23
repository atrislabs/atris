'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sayWish } = require('../lib/wish-delegate');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-say-wish-test-'));
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  const savedAtrisEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedAtrisEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  return {
    root,
    cleanup() {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('ATRIS_')) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(savedAtrisEnv)) {
        process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function captureOutput(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const exitCode = fn();
    return { exitCode, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function writeWishesState(root, records) {
  const wishesFile = path.join(root, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(wishesFile), { recursive: true });
  fs.writeFileSync(wishesFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return wishesFile;
}

function readWishesState(root) {
  const wishesFile = path.join(root, '.atris', 'state', 'wishes.jsonl');
  if (!fs.existsSync(wishesFile)) return [];
  return fs.readFileSync(wishesFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('sayWish: steers the latest steerable wish when no ref is provided', () => {
  const env = setupIsolatedEnv();
  try {
    writeWishesState(env.root, [
      { id: 'wish-1', n: 1, text: 'build landing page', status: 'delegated', ts: '2026-01-01T00:00:00.000Z' },
      { id: 'wish-2', n: 2, text: 'optimize database queries', status: 'delegated', ts: '2026-01-02T00:00:00.000Z' },
    ]);

    const { exitCode, logs, errors } = captureOutput(() => {
      return sayWish(['say', 'keep', 'indexes', 'in', 'mind'], env.root);
    });

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(logs, [
      'Steering captured for "optimize database queries".',
    ]);

    const records = readWishesState(env.root);
    assert.strictEqual(records.length, 3);
    const steerRecord = records[2];
    assert.strictEqual(steerRecord.kind, 'steer');
    assert.strictEqual(steerRecord.wish_id, 'wish-2');
    assert.strictEqual(steerRecord.note, 'keep indexes in mind');
    assert.strictEqual(typeof steerRecord.ts, 'string');
    assert.ok(steerRecord.steered_by);
  } finally {
    env.cleanup();
  }
});

test('sayWish: steers a specific wish when ref is passed as first or last argument', () => {
  const env = setupIsolatedEnv();
  try {
    writeWishesState(env.root, [
      { id: 'wish-1', n: 1, text: 'build landing page', status: 'delegated', ts: '2026-01-01T00:00:00.000Z' },
      { id: 'wish-2', n: 2, text: 'optimize database queries', status: 'delegated', ts: '2026-01-02T00:00:00.000Z' },
    ]);

    // Ref passed first
    const firstResult = captureOutput(() => {
      return sayWish(['say', '1', 'add', 'a', 'hero', 'banner'], env.root);
    });

    assert.strictEqual(firstResult.exitCode, 0);
    assert.deepStrictEqual(firstResult.errors, []);
    assert.deepStrictEqual(firstResult.logs, [
      'Steering captured for "build landing page".',
    ]);

    let records = readWishesState(env.root);
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[2].wish_id, 'wish-1');
    assert.strictEqual(records[2].note, 'add a hero banner');

    // Ref passed last
    const secondResult = captureOutput(() => {
      return sayWish(['say', 'use', 'explain', 'analyze', '2'], env.root);
    });

    assert.strictEqual(secondResult.exitCode, 0);
    assert.deepStrictEqual(secondResult.errors, []);
    assert.deepStrictEqual(secondResult.logs, [
      'Steering captured for "optimize database queries".',
    ]);

    records = readWishesState(env.root);
    assert.strictEqual(records.length, 4);
    assert.strictEqual(records[3].wish_id, 'wish-2');
    assert.strictEqual(records[3].note, 'use explain analyze');
  } finally {
    env.cleanup();
  }
});

test('sayWish: returns error code 2 when note is missing or empty', () => {
  const env = setupIsolatedEnv();
  try {
    // Missing note entirely
    const emptyArgsResult = captureOutput(() => sayWish(['say'], env.root));
    assert.strictEqual(emptyArgsResult.exitCode, 2);
    assert.deepStrictEqual(emptyArgsResult.errors, ['wish say needs a note.']);

    // Whitespace only note
    const whitespaceResult = captureOutput(() => sayWish(['say', '   '], env.root));
    assert.strictEqual(whitespaceResult.exitCode, 2);
    assert.deepStrictEqual(whitespaceResult.errors, ['wish say needs a note.']);

    // Empty array
    const noArgsResult = captureOutput(() => sayWish([], env.root));
    assert.strictEqual(noArgsResult.exitCode, 2);
    assert.deepStrictEqual(noArgsResult.errors, ['wish say needs a note.']);
  } finally {
    env.cleanup();
  }
});

test('sayWish: returns error code 2 when no wishes exist or no open wishes can be steered', () => {
  const env = setupIsolatedEnv();
  try {
    // 1. No wishes in state
    const noWishesResult = captureOutput(() => {
      return sayWish(['say', 'make', 'faster'], env.root);
    });
    assert.strictEqual(noWishesResult.exitCode, 2);
    assert.deepStrictEqual(noWishesResult.errors, ['No wishes to steer yet.']);

    // 2. Wishes exist but all are completed (closed for steer)
    writeWishesState(env.root, [
      { id: 'wish-1', n: 1, text: 'completed task', status: 'complete', ts: '2026-01-01T00:00:00.000Z' },
    ]);
    const noOpenResult = captureOutput(() => {
      return sayWish(['say', 'make', 'faster'], env.root);
    });
    assert.strictEqual(noOpenResult.exitCode, 2);
    assert.deepStrictEqual(noOpenResult.errors, ['No open wishes to steer.']);

    // 3. Unknown wish id referenced
    const unknownRefResult = captureOutput(() => {
      return sayWish(['say', 'wish-nonexistent', 'make', 'faster'], env.root);
    });
    assert.strictEqual(unknownRefResult.exitCode, 2);
    assert.deepStrictEqual(unknownRefResult.errors, ['No wish found with id wish-nonexistent.']);
  } finally {
    env.cleanup();
  }
});

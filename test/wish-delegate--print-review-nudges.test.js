'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printReviewNudges } = require('../lib/wish-delegate');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-nudges-test-'));
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

function captureConsoleLog(fn) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const exitCode = fn();
    return { exitCode, logs };
  } finally {
    console.log = originalLog;
  }
}

test('printReviewNudges: prints review nudges for completed and verified wishes', () => {
  const env = setupIsolatedEnv();
  try {
    const wishesFile = path.join(env.root, '.atris', 'state', 'wishes.jsonl');
    fs.mkdirSync(path.dirname(wishesFile), { recursive: true });

    const records = [
      { id: 'wish-1', n: 1, text: 'speed up boot', status: 'complete' },
      { id: 'wish-2', n: 2, text: 'cleanup cache files', status: 'delegated', verify_status: 'verified' },
    ];
    fs.writeFileSync(wishesFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const { exitCode, logs } = captureConsoleLog(() => printReviewNudges(env.root));

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(logs, [
      'Wishes ready for review:',
      '- #1 speed up boot: atris wish review 1 "<one sentence>"',
      '- #2 cleanup cache files: atris wish review 2 "<one sentence>"',
    ]);
  } finally {
    env.cleanup();
  }
});

test('printReviewNudges: outputs nothing and returns 0 when no wishes exist or wishes file is empty', () => {
  const env = setupIsolatedEnv();
  try {
    // 1. Missing state file
    const firstRun = captureConsoleLog(() => printReviewNudges(env.root));
    assert.strictEqual(firstRun.exitCode, 0);
    assert.deepStrictEqual(firstRun.logs, []);

    // 2. Existing but empty state file
    const wishesFile = path.join(env.root, '.atris', 'state', 'wishes.jsonl');
    fs.mkdirSync(path.dirname(wishesFile), { recursive: true });
    fs.writeFileSync(wishesFile, '', 'utf8');

    const secondRun = captureConsoleLog(() => printReviewNudges(env.root));
    assert.strictEqual(secondRun.exitCode, 0);
    assert.deepStrictEqual(secondRun.logs, []);
  } finally {
    env.cleanup();
  }
});

test('printReviewNudges: filters out already reviewed wishes and in-flight unverified wishes', () => {
  const env = setupIsolatedEnv();
  try {
    const wishesFile = path.join(env.root, '.atris', 'state', 'wishes.jsonl');
    fs.mkdirSync(path.dirname(wishesFile), { recursive: true });

    const records = [
      // Reviewed directly via boolean field
      { id: 'wish-1', n: 1, text: 'already reviewed boolean', status: 'complete', reviewed: true },
      // Shipped wish that gets reviewed via a subsequent review event in the event stream
      { id: 'wish-2', n: 2, text: 'reviewed via event stream', status: 'complete' },
      { kind: 'review', wish_id: 'wish-2', review_text: 'great job' },
      // In-flight wishes that are not shipped
      { id: 'wish-3', n: 3, text: 'still in progress', status: 'delegated' },
      { id: 'wish-4', n: 4, text: 'waiting on operator input', status: 'waiting_input' },
      // Malformed or missing id
      { n: 5, text: 'no id record', status: 'complete' },
    ];
    fs.writeFileSync(wishesFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const { exitCode, logs } = captureConsoleLog(() => printReviewNudges(env.root));

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(logs, []);
  } finally {
    env.cleanup();
  }
});

test('printReviewNudges: handles unnumbered wish and delegated wish with completed mission', () => {
  const env = setupIsolatedEnv();
  try {
    const wishesFile = path.join(env.root, '.atris', 'state', 'wishes.jsonl');
    const missionsFile = path.join(env.root, '.atris', 'state', 'missions.jsonl');
    fs.mkdirSync(path.dirname(wishesFile), { recursive: true });

    const wishes = [
      // Unnumbered wish: formats using meaningful words and trailing 8 chars of id
      { id: 'wish-alpha-12345678', text: 'make responsive layout', status: 'complete' },
      // Delegated wish with linked mission that completed
      { id: 'wish-7', n: 7, text: 'migrate database schema', status: 'delegated', mission_id: 'm-db-7' },
    ];
    fs.writeFileSync(wishesFile, wishes.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const missions = [
      { id: 'm-db-7', status: 'complete' },
    ];
    fs.writeFileSync(missionsFile, missions.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const { exitCode, logs } = captureConsoleLog(() => printReviewNudges(env.root));

    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(logs, [
      'Wishes ready for review:',
      '- make responsive layout: atris wish review 12345678 "<one sentence>"',
      '- #7 migrate database schema: atris wish review 7 "<one sentence>"',
    ]);
  } finally {
    env.cleanup();
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// printRewards resolves its backend through ATRIS_* env vars and walks the
// filesystem, so everything runs inside one disposable tree with a throwaway
// HOME and no inherited ATRIS_* variables.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-rewards-'));
const savedHome = process.env.HOME;
const savedAtrisEnv = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedAtrisEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = sandbox;

test.after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  Object.assign(process.env, savedAtrisEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { printRewards } = require('../commands/wish');

const BACKEND_HINT = 'set ATRIS_BACKEND_ROOT to the backend workspace.';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(sandbox, 'ws-'));
}

function writeJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function writeWishEvents(root, events) {
  writeJsonLines(path.join(root, '.atris', 'state', 'wishes.jsonl'), events);
}

function writeScorecards(backendRoot, rows) {
  writeJsonLines(path.join(backendRoot, '.atris', 'state', 'scorecards.jsonl'), rows);
}

// Env vars point at a dead path or nowhere; the install-sibling probe stays
// off so a backend checkout beside this repo can never leak in.
function clearBackendEnv() {
  delete process.env.ATRIS_BACKEND_ROOT;
  delete process.env.ATRIS_BACKEND_DIR;
  process.env.ATRIS_BACKEND_INSTALL_SIBLING = '0';
}

function capturePrint(fn) {
  const stdout = [];
  const stderr = [];
  const prevLog = console.log;
  const prevError = console.error;
  console.log = (...args) => stdout.push(args.map(String).join(' '));
  console.error = (...args) => stderr.push(args.map(String).join(' '));
  try {
    const code = fn();
    return { code, stdout, stderr };
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
}

test('printRewards prints count, average, last five review lines, and reward rows', () => {
  const ws = makeWorkspace();
  const backend = fs.mkdtempSync(path.join(sandbox, 'backend-'));
  process.env.ATRIS_BACKEND_ROOT = backend;
  try {
    writeWishEvents(ws, [
      { id: 'wish-a', ts: '2026-01-04T09:00:00.000Z', text: 'first wish', status: 'captured' },
      { kind: 'review', wish_id: 'wish-a', ts: '2026-01-05T09:00:00.000Z', review_text: 'good', review_score: 4 },
      { kind: 'review', wish_id: 'wish-b', ts: '2026-01-06T09:00:00.000Z', review_text: 'fine', review_score: 2 },
      { kind: 'review', wish_id: 'wish-c', ts: '2026-01-07T09:00:00.000Z', review_text: 'great', review_score: 5 },
      { kind: 'review', wish_id: 'wish-d', ts: '2026-01-08T09:00:00.000Z', review_text: 'ok', review_score: 3 },
      { kind: 'review', wish_id: 'wish-e', ts: '2026-01-09T09:00:00.000Z', review_text: 'meh', review_score: 1 },
      { kind: 'review', wish_id: 'wish-f', ts: '2026-01-10T09:00:00.000Z', review_text: 'nice', review_score: 5 },
      { kind: 'close', wish_id: 'wish-a', ts: '2026-01-11T09:00:00.000Z' },
    ]);
    writeScorecards(backend, [
      { source: 'wish_review', feedback: 'landed', delta: 1 },
      { source: 'manual', feedback: 'wish_review boosted score', delta: 1 },
      { source: 'mission_tick', feedback: 'unrelated', delta: 0 },
    ]);

    const result = capturePrint(() => printRewards(ws));

    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      'reviews count: 6',
      'avg score: 3.33',
      'last 5 review lines:',
      '- 2026-01-06 score=2 wish-b fine',
      '- 2026-01-07 score=5 wish-c great',
      '- 2026-01-08 score=3 wish-d ok',
      '- 2026-01-09 score=1 wish-e meh',
      '- 2026-01-10 score=5 wish-f nice',
      'reward rows found: 2',
    ]);
    assert.deepEqual(result.stderr, []);
  } finally {
    clearBackendEnv();
  }
});

test('printRewards on an empty workspace prints zero counts, none, and the backend hint', () => {
  const ws = makeWorkspace();
  clearBackendEnv();

  const result = capturePrint(() => printRewards(ws));

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    'reviews count: 0',
    'avg score: n/a',
    'last 5 review lines:',
    '- none',
    'reward rows found: 0',
  ]);
  assert.deepEqual(result.stderr, [BACKEND_HINT]);
});

test('printRewards tolerates missing fields, malformed lines, and a dead backend path', () => {
  const ws = makeWorkspace();
  const file = path.join(ws, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[
    JSON.stringify({ kind: 'review', wish_id: 'wish-x', ts: '2026-02-01T10:00:00.000Z', review_text: 'no score here' }),
    JSON.stringify({ kind: 'review' }),
    'this is not json',
    'null',
    JSON.stringify({ kind: 'review', wish_id: 'wish-y', ts: '2026-02-03T10:00:00.000Z', review_text: 'scored', review_score: '5' }),
  ].join('\n')}\n`, 'utf8');
  process.env.ATRIS_BACKEND_ROOT = path.join(sandbox, 'missing-backend');
  process.env.ATRIS_BACKEND_INSTALL_SIBLING = '0';
  try {
    const result = capturePrint(() => printRewards(ws));

    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      'reviews count: 3',
      'avg score: 5',
      'last 5 review lines:',
      '- 2026-02-01 score=n/a wish-x no score here',
      '- unknown-date score=n/a unknown',
      '- 2026-02-03 score=5 wish-y scored',
      'reward rows found: 0',
    ]);
    assert.deepEqual(result.stderr, [BACKEND_HINT]);
  } finally {
    clearBackendEnv();
  }
});

'use strict';

// appendRosterAttempts writes one run line per attempt, oldest first, and each
// attempt that another follows names that next engine as who took over. Every
// room is a fresh folder under the system temp dir with fixed dates passed in,
// so nothing depends on the clock, the time zone, or this machine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAVED_ENV = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
}
const SAVED_HOME = process.env.HOME;
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-attempts-home-'));
process.env.HOME = HOME_DIR;

const {
  appendRosterAttempts,
  rosterRunsPath,
  rotatedRunsPaths,
  RUNS_ROTATE_BYTES,
} = require('../lib/roster-runs');

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const rooms = [HOME_DIR];

function room(label = 'room') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `atris-roster-attempts-${label}-`));
  rooms.push(dir);
  return dir;
}

function logLines(root) {
  const file = rosterRunsPath(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test.after(() => {
  for (const dir of rooms) fs.rmSync(dir, { recursive: true, force: true });
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
  Object.assign(process.env, SAVED_ENV);
});

test('appendRosterAttempts writes one line per attempt and chains who took over', () => {
  const root = room('chain');
  const shared = { job: 'executor', member: 'builder-1', task: 'CLI-900', source: 'fleet' };
  const attempts = [
    { at: '2026-09-27T10:00:00.000Z', engine: 'devin', model: 'swe-2-max', outcome: 'stalled', seconds: 600.4, max_seconds: 1200 },
    { at: '2026-09-27T10:11:00.000Z', engine: 'cursor', outcome: 'failed', detail: '  hit   an\n error  ', seconds: 30 },
    { at: '2026-09-27T10:12:00.000Z', engine: 'codex', outcome: 'landed', seconds: 90, tokens: '12,345', cost_usd: 0.42 },
  ];

  const written = appendRosterAttempts(root, attempts, shared, { now: NOW });

  assert.deepStrictEqual(written, [
    {
      at: '2026-09-27T10:00:00.000Z',
      job: 'build',
      engine: 'devin',
      outcome: 'stalled',
      member: 'builder-1',
      model: 'swe-2-max',
      task: 'CLI-900',
      handed_over_to: 'cursor',
      source: 'fleet',
      max_seconds: 1200,
      seconds: 600,
    },
    {
      at: '2026-09-27T10:11:00.000Z',
      job: 'build',
      engine: 'cursor',
      outcome: 'failed',
      member: 'builder-1',
      task: 'CLI-900',
      detail: 'hit an error',
      handed_over_to: 'codex',
      source: 'fleet',
      seconds: 30,
    },
    {
      at: '2026-09-27T10:12:00.000Z',
      job: 'build',
      engine: 'codex',
      outcome: 'landed',
      member: 'builder-1',
      task: 'CLI-900',
      source: 'fleet',
      seconds: 90,
      tokens: 12345,
      cost_usd: 0.42,
    },
  ]);
  assert.deepStrictEqual(logLines(root), written);
  assert.strictEqual(rosterRunsPath(root), path.join(root, '.atris', 'state', 'roster_runs.jsonl'));
});

test('appendRosterAttempts lets each attempt override the shared fields', () => {
  const root = room('override');
  const written = appendRosterAttempts(
    root,
    [
      { engine: 'claude', job: 'validator', outcome: 'landed', at: '2026-09-27T09:00:00.000Z' },
      { engine: 'codex', outcome: 'landed', at: '2026-09-27T09:05:00.000Z', handed_over_to: 'grok' },
    ],
    { job: 'build', task: 'CLI-1' },
  );

  assert.strictEqual(written[0].job, 'review');
  assert.strictEqual(written[1].job, 'build');
  assert.strictEqual(written[0].task, 'CLI-1');
  assert.strictEqual(written[1].task, 'CLI-1');
  assert.strictEqual(written[0].handed_over_to, 'codex');
  // The last attempt has nobody after it, so what it says for itself stays.
  assert.strictEqual(written[1].handed_over_to, 'grok');
});

test('appendRosterAttempts skips empty slots and only names a next attempt that has an engine', () => {
  const root = room('skip');
  const at = '2026-09-27T08:00:00.000Z';

  const gapped = appendRosterAttempts(root, [
    { engine: 'devin', outcome: 'failed', at },
    null,
    undefined,
    false,
    { engine: 'cursor', outcome: 'landed', at },
  ], {}, { now: NOW });
  assert.strictEqual(gapped.length, 2);
  assert.strictEqual(gapped[0].handed_over_to, 'cursor');
  assert.strictEqual('handed_over_to' in gapped[1], false);

  const noEngine = appendRosterAttempts(root, [
    { engine: 'grok', outcome: 'failed', at },
    { outcome: 'landed', at },
  ], {}, { now: NOW });
  assert.strictEqual(noEngine.length, 2);
  assert.strictEqual('handed_over_to' in noEngine[0], false);
  assert.strictEqual(noEngine[1].engine, 'unknown');

  assert.strictEqual(logLines(root).length, 4);
});

test('appendRosterAttempts fills gaps and drops bad values instead of guessing', () => {
  const root = room('defaults');

  const [bare] = appendRosterAttempts(root, [{}], {}, { now: NOW });
  assert.deepStrictEqual(bare, {
    at: '2026-09-27T12:00:00.000Z',
    job: 'build',
    engine: 'unknown',
    outcome: 'failed',
  });

  const [odd] = appendRosterAttempts(root, [{
    at: '2026-09-27T12:30:00.000Z',
    engine: ' codex ',
    outcome: 'exploded',
    seconds: -5,
    max_seconds: 0,
    tokens: 'abc',
    cost_usd: '0.5',
    detail: 'd'.repeat(300),
    prep: 'p'.repeat(200),
    brief_lines: '12',
    brief_bytes: -1,
  }], { job: 'Small Build' }, { now: () => NOW });
  assert.strictEqual(odd.engine, 'codex');
  assert.strictEqual(odd.outcome, 'failed');
  assert.strictEqual(odd.job, 'small build');
  assert.strictEqual(odd.detail.length, 240);
  assert.strictEqual(odd.prep.length, 160);
  assert.strictEqual(odd.brief_lines, 12);
  for (const key of ['seconds', 'max_seconds', 'tokens', 'cost_usd', 'brief_bytes']) {
    assert.strictEqual(key in odd, false, `${key} should be left out`);
  }
});

test('appendRosterAttempts with nothing to record writes nothing and returns an empty list', () => {
  const root = room('empty');

  assert.deepStrictEqual(appendRosterAttempts(root, []), []);
  assert.deepStrictEqual(appendRosterAttempts(root, null), []);
  assert.deepStrictEqual(appendRosterAttempts(root, undefined), []);
  assert.deepStrictEqual(appendRosterAttempts(root, [null, undefined, false, 0, '']), []);
  assert.strictEqual(fs.existsSync(path.join(root, '.atris')), false);
});

test('appendRosterAttempts leaves the attempts and shared fields it was given untouched', () => {
  const root = room('frozen');
  const attempts = Object.freeze([
    Object.freeze({ engine: 'devin', outcome: 'failed', at: '2026-09-27T07:00:00.000Z' }),
    Object.freeze({ engine: 'codex', outcome: 'landed', at: '2026-09-27T07:05:00.000Z' }),
  ]);
  const shared = Object.freeze({ job: 'build' });

  const written = appendRosterAttempts(root, attempts, shared, { now: NOW });

  assert.strictEqual(written.length, 2);
  assert.strictEqual('handed_over_to' in attempts[0], false);
  assert.deepStrictEqual(shared, { job: 'build' });
});

test('appendRosterAttempts returns null for a line it cannot write and does not throw', () => {
  const base = room('blocked');
  const blocker = path.join(base, 'not-a-folder');
  fs.writeFileSync(blocker, 'a file where a folder should be', 'utf8');

  const written = appendRosterAttempts(path.join(blocker, 'project'), [
    { engine: 'devin', outcome: 'failed', at: '2026-09-27T06:00:00.000Z' },
    { engine: 'codex', outcome: 'landed', at: '2026-09-27T06:05:00.000Z' },
  ], { job: 'build' }, { now: NOW });

  assert.deepStrictEqual(written, [null, null]);
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'a file where a folder should be');
});

test('appendRosterAttempts from a linked worktree records in the main checkout', () => {
  const base = room('worktree');
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'linked'), { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'linked')}\n`, 'utf8');

  const written = appendRosterAttempts(linked, [
    { engine: 'cursor', outcome: 'landed', at: '2026-09-27T05:00:00.000Z' },
  ], { job: 'build' }, { now: NOW });

  assert.strictEqual(written.length, 1);
  assert.deepStrictEqual(logLines(main), written);
  assert.strictEqual(fs.existsSync(path.join(linked, '.atris')), false);
});

test('appendRosterAttempts moves a full log aside whole before the first line lands', () => {
  const root = room('rotate');
  const file = rosterRunsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = 'x\n'.repeat(RUNS_ROTATE_BYTES / 2);
  fs.writeFileSync(file, old, 'utf8');

  const written = appendRosterAttempts(root, [
    { engine: 'devin', outcome: 'failed', at: '2026-09-27T04:00:00.000Z' },
    { engine: 'codex', outcome: 'landed', at: '2026-09-27T04:05:00.000Z' },
  ], { job: 'build' }, { now: NOW });

  assert.strictEqual(written.length, 2);
  const rotated = rotatedRunsPaths(root);
  assert.strictEqual(rotated.length, 1);
  assert.strictEqual(path.basename(rotated[0]), `roster_runs.20260927T120000.000Z-${process.pid}.jsonl`);
  assert.strictEqual(fs.readFileSync(rotated[0], 'utf8'), old);
  assert.deepStrictEqual(logLines(root), written);
});

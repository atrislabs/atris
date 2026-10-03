'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  memberResult,
  memberResultCommand,
  obviousNumber,
  parseResultArgs,
} = require('../lib/member-result');

function writeFileAt(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-result-')));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'film-studio'), { recursive: true });
  return root;
}

const STARTED = '2026-10-03T00:58:15.621Z';

function writeRuns(root, rows) {
  writeFileAt(path.join(root, '.atris', 'state', 'roster_runs.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('member result args: one member, optional iso --since, json', () => {
  assert.deepEqual(parseResultArgs(['film-studio', '--since', '2026-10-02T00:00:00Z', '--json']), {
    help: false, member: 'film-studio', since: '2026-10-02T00:00:00Z', json: true,
  });
  assert.throws(() => parseResultArgs([]), /usage/);
  assert.throws(() => parseResultArgs(['a', 'b']), /usage/);
  assert.throws(() => parseResultArgs(['film-studio', '--since', 'yesterday']), /not a time/);
  assert.throws(() => parseResultArgs(['../etc']), /not a member name/);
});

test('one obvious number: a single percent, dollar, or count; two different values means none', () => {
  assert.deepEqual(obviousNumber('pass rate went to 82% on the new pack'), { value: 82, text: '82%', kind: 'percent' });
  assert.deepEqual(obviousNumber('found $1.5k of waste'), { value: 1500, text: '$1.5k', kind: 'dollars' });
  assert.deepEqual(obviousNumber('## 18:00 PT\n- wrote 7 shots for the shoot'), { value: 7, text: '7 shots', kind: 'count' });
  assert.equal(obviousNumber('82% then 90%'), null);
  assert.equal(obviousNumber('## 18:01 · tick 1\n- verifier: passed\n- exit 0'), null);
  assert.equal(obviousNumber(''), null);
});

test('reads the newest run, its worktree receipt, and files made after it started', () => {
  const root = workspace();
  const worktree = workspace();
  writeRuns(root, [
    { at: '2026-10-01T10:00:00.000Z', job: 'build', engine: 'claude', outcome: 'failed', member: 'film-studio', task: 'mission-old', source: 'mission', seconds: 30 },
    { at: STARTED, job: 'build', engine: 'claude', outcome: 'landed', member: 'film-studio', model: 'claude-opus-5-5', task: 'mission-new', source: 'mission', seconds: 173 },
    { at: '2026-10-03T02:00:00.000Z', job: 'ask', engine: 'claude', outcome: 'landed', source: 'ask', seconds: 9 },
  ]);
  const before = new Date('2026-10-02T12:00:00Z');
  const after = new Date('2026-10-03T01:00:00Z');
  writeFileAt(path.join(root, 'atris', 'team', 'film-studio', 'logs', '2026-10-01.md'), 'old receipt 99%', before);
  writeFileAt(path.join(worktree, 'atris', 'team', 'film-studio', 'logs', '2026-10-02.md'), '## done\n- shot list ready: 7 shots\n', after);
  writeFileAt(path.join(worktree, 'work', 'canvas-smoke', 'hello.md'), 'hello\n', after);
  writeFileAt(path.join(root, 'atris', 'team', 'film-studio', 'work', 'old.md'), 'old\n', before);
  writeFileAt(path.join(worktree, 'atris', 'team', 'film-studio', 'work', 'clip.bin'), Buffer.from([0, 1, 2, 3]), after);

  const result = memberResult(root, 'film-studio', {
    now: new Date('2026-10-03T03:00:00Z'),
    deps: { listWorktreeRollupMissions: () => [{ id: 'mission-new', worktree_root: worktree }] },
  });
  assert.equal(result.ok, true);
  const value = result.value;
  assert.deepEqual(value.run, {
    id: 'mission-new',
    started: STARTED,
    ended: '2026-10-03T01:01:08.621Z',
    status: 'landed',
    engine: 'claude',
    model: 'claude-opus-5-5',
    seconds: 173,
  });
  assert.equal(value.since, STARTED);
  assert.equal(value.worktree, worktree);
  assert.equal(value.receipt.path, path.join(worktree, 'atris', 'team', 'film-studio', 'logs', '2026-10-02.md'));
  assert.match(value.receipt.head, /7 shots/);
  const paths = value.artifacts.map((file) => path.relative(worktree, file.path)).sort();
  assert.deepEqual(paths, [path.join('atris', 'team', 'film-studio', 'work', 'clip.bin'), path.join('work', 'canvas-smoke', 'hello.md')]);
  const hello = value.artifacts.find((file) => file.path.endsWith('hello.md'));
  assert.equal(hello.head, 'hello');
  assert.equal(hello.size, 6);
  assert.equal(value.artifacts.find((file) => file.path.endsWith('clip.bin')).head, null);
  assert.equal(value.number, 7);
  assert.equal(value.number_text, '7 shots');
});

test('--since widens the window; a member with no runs still reads its own folder', () => {
  const root = workspace();
  writeFileAt(path.join(root, 'atris', 'team', 'film-studio', 'logs', '2026-10-01.md'), 'saved $794 this week', new Date('2026-10-02T12:00:00Z'));
  const value = memberResult(root, 'film-studio', { since: '2026-10-02T00:00:00Z' }).value;
  assert.equal(value.run, null);
  assert.equal(value.worktree, null);
  assert.match(value.receipt.path, /2026-10-01\.md$/);
  assert.equal(value.number, 794);
  assert.deepEqual(value.artifacts, []);
});

test('an unknown member is an error, printed as json with exit 1', () => {
  const root = workspace();
  const out = [];
  const log = console.log;
  console.log = (...args) => out.push(args.join(' '));
  let code;
  try {
    code = memberResultCommand(['nobody', '--json'], { root });
  } finally {
    console.log = log;
  }
  assert.equal(code, 1);
  assert.equal(JSON.parse(out.join('\n')).ok, false);
});

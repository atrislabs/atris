const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { closeLostRuns, RESOURCE_LOG } = require('../lib/engine-resource');

// Far above any real pid limit, so the process is certainly gone.
const DEAD_PID = 2147483646;
const NOW = '2026-01-02T03:04:05.000Z';
const fixedNow = () => NOW;

const savedEnv = {};
const tempDirs = [];

test.before(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = tempRoot();
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-lost-runs-'));
  tempDirs.push(dir);
  return dir;
}

function logPath(root) {
  return path.join(root, RESOURCE_LOG);
}

function writeLog(root, lines) {
  fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
  fs.writeFileSync(logPath(root), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

function readLog(root) {
  return fs.readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function start(run_id, extra = {}) {
  return { at: '2026-01-01T00:00:00.000Z', phase: 'start', engine: 'codex', task: 'T-1', run_id, ...extra };
}

test('closes an unfinished run whose parent is gone and appends the end line', () => {
  const root = tempRoot();
  writeLog(root, [start('run-dead', { pid: DEAD_PID })]);

  const closed = closeLostRuns(root, { now: fixedNow });

  const expected = {
    at: NOW,
    phase: 'end',
    engine: 'codex',
    task: 'T-1',
    run_id: 'run-dead',
    cause: 'parent gone',
    closed_by: 'sweep',
  };
  assert.deepStrictEqual(closed, [expected]);
  const log = readLog(root);
  assert.strictEqual(log.length, 2);
  assert.deepStrictEqual(log[1], expected);
});

test('a second pass finds nothing left to close and leaves the log alone', () => {
  const root = tempRoot();
  writeLog(root, [start('run-dead', { pid: DEAD_PID })]);

  assert.strictEqual(closeLostRuns(root, { now: fixedNow }).length, 1);
  const afterFirst = fs.readFileSync(logPath(root), 'utf8');

  assert.deepStrictEqual(closeLostRuns(root, { now: fixedNow }), []);
  assert.strictEqual(fs.readFileSync(logPath(root), 'utf8'), afterFirst);
});

test('leaves alone runs that ended, runs still alive, and runs with no usable pid', () => {
  const root = tempRoot();
  writeLog(root, [
    start('run-finished', { pid: DEAD_PID }),
    { at: '2026-01-01T00:01:00.000Z', phase: 'end', engine: 'codex', task: 'T-1', run_id: 'run-finished' },
    start('run-alive', { pid: process.pid }),
    start('run-old-no-pid'),
    start('run-zero-pid', { pid: 0 }),
    start('run-negative-pid', { pid: -5 }),
    start('run-string-pid', { pid: String(DEAD_PID) }),
    { at: '2026-01-01T00:02:00.000Z', phase: 'start', engine: 'codex', task: 'T-1', pid: DEAD_PID },
  ]);
  const before = fs.readFileSync(logPath(root), 'utf8');

  assert.deepStrictEqual(closeLostRuns(root, { now: fixedNow }), []);
  assert.strictEqual(fs.readFileSync(logPath(root), 'utf8'), before);
});

test('closes only the lost runs when dead, alive, and finished runs are mixed, in log order', () => {
  const root = tempRoot();
  writeLog(root, [
    start('run-a', { pid: DEAD_PID, engine: 'cursor', task: 'T-A' }),
    start('run-b', { pid: process.pid }),
    start('run-c', { pid: DEAD_PID, engine: 'devin', task: 'T-C' }),
    start('run-d', { pid: DEAD_PID }),
    { at: '2026-01-01T00:03:00.000Z', phase: 'end', engine: 'codex', task: 'T-1', run_id: 'run-d' },
  ]);

  const closed = closeLostRuns(root, { now: fixedNow });

  assert.deepStrictEqual(closed.map((end) => end.run_id), ['run-a', 'run-c']);
  assert.deepStrictEqual(closed.map((end) => [end.engine, end.task]), [['cursor', 'T-A'], ['devin', 'T-C']]);
  const log = readLog(root);
  assert.strictEqual(log.length, 7);
  assert.deepStrictEqual(log.slice(-2), closed);
});

test('a start line with no engine or task closes with empty strings', () => {
  const root = tempRoot();
  writeLog(root, [{ at: '2026-01-01T00:00:00.000Z', phase: 'start', run_id: 'run-bare', pid: DEAD_PID }]);

  const [end] = closeLostRuns(root, { now: fixedNow });

  assert.strictEqual(end.engine, '');
  assert.strictEqual(end.task, '');
  assert.strictEqual(end.run_id, 'run-bare');
});

test('skips blank lines, broken JSON, and non-object lines while still closing lost runs', () => {
  const root = tempRoot();
  writeLog(root, [
    'not json at all',
    '',
    'null',
    '42',
    '"just a string"',
    '[1,2,3]',
    '{"phase":"start","engine":"codex"',
    start('run-dead', { pid: DEAD_PID }),
  ]);

  const closed = closeLostRuns(root, { now: fixedNow });

  assert.deepStrictEqual(closed.map((end) => end.run_id), ['run-dead']);
});

test('returns an empty list and writes nothing when there is no log yet', () => {
  const root = tempRoot();

  assert.deepStrictEqual(closeLostRuns(root, { now: fixedNow }), []);
  assert.strictEqual(fs.existsSync(logPath(root)), false);
});

test('returns an empty list for a log that exists but is empty', () => {
  const root = tempRoot();
  fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
  fs.writeFileSync(logPath(root), '');

  assert.deepStrictEqual(closeLostRuns(root, { now: fixedNow }), []);
  assert.strictEqual(fs.readFileSync(logPath(root), 'utf8'), '');
});

test('throws a plain error when the log cannot be read for a reason other than being absent', () => {
  const root = tempRoot();
  // A file where the state folder should be makes the log path unreadable.
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state'), 'not a folder');

  assert.throws(
    () => closeLostRuns(root, { now: fixedNow }),
    (err) => err instanceof Error && /^could not read the engine run log: ENOTDIR$/.test(err.message),
  );
  assert.strictEqual(fs.readFileSync(path.join(root, '.atris', 'state'), 'utf8'), 'not a folder');
});

test('reads and writes the main project log when the root is a linked build folder', () => {
  const main = tempRoot();
  const linked = tempRoot();
  const gitdir = path.join(main, '.git', 'worktrees', 'build-1');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${gitdir}\n`);
  writeLog(main, [start('run-from-main', { pid: DEAD_PID })]);

  const closed = closeLostRuns(linked, { now: fixedNow });

  assert.deepStrictEqual(closed.map((end) => end.run_id), ['run-from-main']);
  assert.strictEqual(readLog(main).length, 2);
  assert.strictEqual(fs.existsSync(logPath(linked)), false);
});

test('stamps the end line with the current time when no clock is passed', () => {
  const root = tempRoot();
  writeLog(root, [start('run-dead', { pid: DEAD_PID })]);

  const [end] = closeLostRuns(root);

  assert.strictEqual(typeof end.at, 'string');
  assert.ok(!Number.isNaN(Date.parse(end.at)));
  assert.strictEqual(end.cause, 'parent gone');
});

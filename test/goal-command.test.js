'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../commands/goal');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-cmd-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function capture(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    const status = fn();
    return { status, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function scoreboardPath(dir) {
  return path.join(dir, '.atris', 'state', 'scoreboard.json');
}

test('help prints usage and exits zero', () => {
  const result = capture(() => run(['--help']));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: atris goal \[--json\]/);
  assert.match(result.stdout, /atris goal set "<sentence>" \[--no-wish\]/);
  assert.match(result.stdout, /atris goal metric <name> --rm/);
});

test('set writes a normalized goal to the scoreboard and show renders it', () => {
  const dir = makeTempDir();
  try {
    const set = capture(() => run(['set', 'Ship', '  The\tThing', '--no-wish'], { cwd: dir }));
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout, 'goal set.');

    const saved = JSON.parse(fs.readFileSync(scoreboardPath(dir), 'utf8'));
    assert.equal(saved.goal, 'ship the thing');
    assert.ok(saved.updated_at, 'updated_at is stamped');

    const show = capture(() => run([], { cwd: dir }));
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^ {2}goal {6}ship the thing$/m);
    assert.match(show.stdout, /^ {2}today {5}no movement recorded today$/m);
    assert.match(show.stdout, /^ {2}next {6}atris task day$/m);
  } finally {
    cleanup(dir);
  }
});

test('set without a sentence and an unknown command both fail with usage errors', () => {
  const dir = makeTempDir();
  try {
    const empty = capture(() => run(['set', '--no-wish'], { cwd: dir }));
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /error: goal sentence is required/);
    assert.ok(!fs.existsSync(scoreboardPath(dir)), 'no scoreboard is written');

    const bogus = capture(() => run(['bogus'], { cwd: dir }));
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /error: unknown goal command: bogus/);
  } finally {
    cleanup(dir);
  }
});

test('metric upsert, remove, and empty-name error all hit the scoreboard', () => {
  const dir = makeTempDir();
  try {
    const missing = capture(() => run(['metric'], { cwd: dir }));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /error: metric name is required/);

    const set = capture(() => run(['metric', 'Demos Booked', '4'], { cwd: dir }));
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout, 'metric demos booked set.');

    const noValue = capture(() => run(['metric', 'demos booked'], { cwd: dir }));
    assert.equal(noValue.status, 2);
    assert.match(noValue.stderr, /error: metric value is required/);

    const show = capture(() => run(['--json'], { cwd: dir }));
    assert.equal(show.status, 0, show.stderr);
    const view = JSON.parse(show.stdout);
    assert.deepEqual(view.metrics, [{ name: 'demos booked', value: '4' }]);

    const removed = capture(() => run(['metric', 'demos booked', '--rm'], { cwd: dir }));
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout, 'metric demos booked removed.');
    const saved = JSON.parse(fs.readFileSync(scoreboardPath(dir), 'utf8'));
    assert.deepEqual(saved.metrics, []);
  } finally {
    cleanup(dir);
  }
});

test('today counts tasks landed today and queued for review, and next points at reviews', () => {
  const dir = makeTempDir();
  try {
    const now = new Date();
    const projectionDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(projectionDir, { recursive: true });
    fs.writeFileSync(path.join(projectionDir, 'tasks.projection.json'), `${JSON.stringify({
      tasks: [
        { status: 'done', done_at: now.toISOString() },
        { status: 'done', done_at: '2001-01-01T00:00:00.000Z' },
        { status: 'review' },
        { status: 'open' },
      ],
    })}\n`, 'utf8');

    const show = capture(() => run([], { cwd: dir, now }));
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^ {2}today {5}1 task landed, 1 waiting for your ok$/m);
    assert.match(show.stdout, /^ {2}next {6}atris task reviews$/m);
  } finally {
    cleanup(dir);
  }
});

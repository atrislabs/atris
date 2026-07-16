'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(command, args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, command, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      atris_skip_update_check: '1',
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CI: 'true',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function projectionPath(dir) {
  return path.join(dir, '.atris', 'state', 'tasks.projection.json');
}

test('set then show round-trips the goal', () => {
  const dir = makeTempDir();
  try {
    const set = runCli('goal', ['set', 'First Outside Customer Pays For Atris'], dir);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout.trim(), 'goal set.');

    const show = runCli('goal', [], dir);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(show.stdout.trimEnd(), [
      '  goal      first outside customer pays for atris',
      '  today     no movement recorded today',
      '  next      atris task day',
    ].join('\n'));

    const stateDir = path.join(dir, '.atris', 'state');
    assert.deepEqual(fs.readdirSync(stateDir).filter((name) => name.includes('scoreboard.json.')), []);
  } finally {
    cleanup(dir);
  }
});

test('metric upsert and remove keep one ordered metric', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli('goal', ['set', 'ship it'], dir).status, 0);
    assert.equal(runCli('goal', ['metric', 'demos booked', '0'], dir).status, 0);
    assert.equal(runCli('goal', ['metric', 'demos booked', '4'], dir).status, 0);

    const show = runCli('goal', [], dir);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^  distance  demos booked: 4$/m);
    assert.doesNotMatch(show.stdout, /demos booked: 0/);

    const removed = runCli('goal', ['metric', 'demos booked', '--rm'], dir);
    assert.equal(removed.status, 0, removed.stderr);
    const json = runCli('goal', ['--json'], dir);
    assert.deepEqual(JSON.parse(json.stdout).metrics, []);
  } finally {
    cleanup(dir);
  }
});

test('missing scoreboard degrades with the set hint and keeps today and next', () => {
  const dir = makeTempDir();
  try {
    writeJson(projectionPath(dir), {
      tasks: [{ id: 'review-1', status: 'review' }],
    });
    const show = runCli('goal', [], dir);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(show.stdout.trimEnd(), [
      '  goal      goal not set. set it: atris goal set "<sentence>"',
      '  today     0 tasks landed, 1 waiting for your ok',
      '  next      atris task reviews',
    ].join('\n'));
  } finally {
    cleanup(dir);
  }
});

test('--json emits goal, metrics, today, and next', () => {
  const dir = makeTempDir();
  try {
    const now = new Date();
    const old = new Date(now);
    old.setDate(old.getDate() - 1);
    assert.equal(runCli('goal', ['set', 'first customer pays'], dir).status, 0);
    assert.equal(runCli('goal', ['metric', 'paying customers', '0'], dir).status, 0);
    writeJson(projectionPath(dir), {
      tasks: [
        { id: 'done-today', status: 'done', done_at: now.toISOString() },
        { id: 'done-old', status: 'done', done_at: old.toISOString() },
        { id: 'review-1', status: 'review' },
      ],
    });
    const missionsPath = path.join(dir, '.atris', 'state', 'missions.jsonl');
    fs.writeFileSync(missionsPath, `${JSON.stringify({
      id: 'mission-today',
      status: 'complete',
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    })}\n`, 'utf8');

    const result = runCli('goal', ['--json'], dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      goal: 'first customer pays',
      metrics: [{ name: 'paying customers', value: '0' }],
      today: '1 task landed, 1 waiting for your ok, 1 mission completed',
      next: 'atris task reviews',
    });
  } finally {
    cleanup(dir);
  }
});

test('wtf alias reaches the same output', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli('goal', ['set', 'make the number move'], dir).status, 0);
    assert.equal(runCli('goal', ['metric', 'demos booked', '3'], dir).status, 0);
    const goal = runCli('goal', [], dir);
    const wtf = runCli('wtf', [], dir);
    assert.equal(goal.status, 0, goal.stderr);
    assert.equal(wtf.status, 0, wtf.stderr);
    assert.equal(wtf.stdout, goal.stdout);
  } finally {
    cleanup(dir);
  }
});

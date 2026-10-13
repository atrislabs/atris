'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace({ init = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-wish-test-'));
  if (init) fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGoal(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, 'goal', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      atris_skip_update_check: '1',
      ATRIS_WISH_NO_DRIVER: '1',
      CI: 'true',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function wishRows(dir) {
  const file = path.join(dir, '.atris', 'state', 'wishes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const SENTENCE = 'Add a --version flag to the cli that prints the package version';

test('goal set also files a wish, prints its id and the next step, and keeps the goal', () => {
  const dir = makeWorkspace();
  try {
    const set = runGoal(['set', SENTENCE], dir);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /^goal set\./m);
    const rows = wishRows(dir);
    assert.ok(rows.length >= 1, 'a wish record is written');
    const wishId = rows[0].id;
    assert.equal(rows[0].text, SENTENCE, 'wish keeps the original casing');
    assert.match(set.stdout, new RegExp(`wish id\\s+${wishId}`));
    // With a working builder the next step is `wish again`; with none (CI) the wish asks which builder to use.
    assert.match(set.stdout, new RegExp(`next\\s+atris wish (again ${wishId} |answer )`));
    // capture only: no mission, no driver
    assert.ok(rows.some((row) => row.status === 'captured_no_mission' || row.status === 'needs_input'));
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
    // existing behavior intact
    const scoreboard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scoreboard.json'), 'utf8'));
    assert.equal(scoreboard.goal, SENTENCE.toLowerCase());
  } finally {
    cleanup(dir);
  }
});

test('goal set --no-wish only sets the goal', () => {
  const dir = makeWorkspace();
  try {
    const set = runGoal(['set', '--no-wish', SENTENCE], dir);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout.trim(), 'goal set.');
    assert.equal(wishRows(dir).length, 0);
    const trailing = runGoal(['set', SENTENCE, '--no-wish'], dir);
    assert.equal(trailing.stdout.trim(), 'goal set.');
    assert.equal(wishRows(dir).length, 0);
    const scoreboard = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'scoreboard.json'), 'utf8'));
    assert.equal(scoreboard.goal, SENTENCE.toLowerCase(), '--no-wish is not part of the goal text');
  } finally {
    cleanup(dir);
  }
});

test('setting the same goal twice does not stack duplicate wishes', () => {
  const dir = makeWorkspace();
  try {
    assert.equal(runGoal(['set', SENTENCE], dir).status, 0);
    const first = wishRows(dir);
    const again = runGoal(['set', SENTENCE], dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`wish already filed: ${first[0].id}`));
    assert.equal(wishRows(dir).length, first.length);
  } finally {
    cleanup(dir);
  }
});

test('goal set in a folder with no atris workspace still sets the goal and files no wish', () => {
  const dir = makeWorkspace({ init: false });
  try {
    const set = runGoal(['set', SENTENCE], dir);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout.trim(), 'goal set.');
    assert.match(set.stderr, /wish not filed/);
    assert.equal(wishRows(dir).length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanup(dir);
  }
});

test('a vague goal points at the wish answer step instead of wish again', () => {
  const dir = makeWorkspace();
  try {
    const set = runGoal(['set', 'First Outside Customer Pays For Atris'], dir);
    assert.equal(set.status, 0, set.stderr);
    const rows = wishRows(dir);
    assert.ok(rows.some((row) => row.status === 'needs_input'));
    assert.match(set.stdout, /next\s+atris wish answer/);
  } finally {
    cleanup(dir);
  }
});

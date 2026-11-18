'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');
const periodGoals = require('../lib/period-goals');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-period-goal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function atris(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CLAUDECODE|CODEX|ATRIS_AGENT|CURSOR_AGENT)/.test(key)) delete env[key];
  return spawnSync(process.execPath, [BIN, 'goal', ...args], { cwd: root, encoding: 'utf8', env });
}

test('day goals key on their own date and never roll over', (t) => {
  const root = tempRoot(t);
  periodGoals.setPeriodGoal(root, 'day', 'ship the day goal', { date: '2026-11-16' });
  periodGoals.setPeriodGoal(root, 'day', 'review it', { date: '2026-11-17' });
  assert.equal(periodGoals.getPeriodGoal(root, 'day', { date: '2026-11-16' }).text, 'ship the day goal');
  assert.equal(periodGoals.getPeriodGoal(root, 'day', { date: '2026-11-17' }).text, 'review it');
  assert.equal(periodGoals.getPeriodGoal(root, 'day', { date: '2026-11-18' }).text, null);
  const cleared = periodGoals.clearPeriodGoal(root, 'day', { date: '2026-11-16' });
  assert.equal(cleared.cleared, true);
  assert.equal(periodGoals.getPeriodGoal(root, 'day', { date: '2026-11-17' }).text, 'review it');
});

test('week goals resolve any date to that local monday', (t) => {
  const root = tempRoot(t);
  const set = periodGoals.setPeriodGoal(root, 'week', 'weekly aim', { date: '2026-11-19' });
  assert.equal(set.week_of, '2026-11-16');
  assert.equal(periodGoals.getPeriodGoal(root, 'week', { date: '2026-11-22' }).text, 'weekly aim');
  assert.equal(periodGoals.getPeriodGoal(root, 'week', { date: '2026-11-23' }).text, null);
  assert.equal(periodGoals.periodKey('week', null, new Date(2026, 10, 16, 23, 30)), '2026-11-16');
});

test('malformed and impossible dates are refused without writing', (t) => {
  const root = tempRoot(t);
  for (const bad of ['2026-02-30', '2026-13-01', '11/16/2026', '2026-1-1', 'tomorrow']) {
    assert.throws(() => periodGoals.setPeriodGoal(root, 'day', 'x', { date: bad }), periodGoals.PeriodGoalError, bad);
  }
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'period_goals.json')), false);
});

test('cli sets, reads as json and clears without touching the main goal', (t) => {
  const root = tempRoot(t);
  assert.equal(atris(root, ['set', 'the overarching goal', '--no-wish']).status, 0);
  const set = atris(root, ['day', 'set', 'finish', 'the', 'slice', '--date', '2026-11-16', '--json']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).text, 'finish the slice');
  const week = atris(root, ['week', 'set', 'land goals', '--date=2026-11-18']);
  assert.equal(week.status, 0, week.stderr);
  assert.match(week.stdout, /week goal set for week of 2026-11-16/);
  const read = JSON.parse(atris(root, ['week', '--date', '2026-11-16', '--json']).stdout);
  assert.equal(read.text, 'land goals');
  const bad = atris(root, ['day', 'set', 'x', '--date', '2026-02-31']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a real date/);
  const board = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'scoreboard.json'), 'utf8'));
  assert.equal(board.goal, 'the overarching goal');
  assert.equal(atris(root, ['day', 'clear', '--date', '2026-11-16']).status, 0);
  assert.equal(JSON.parse(atris(root, ['day', '--date', '2026-11-16', '--json']).stdout).text, null);
});

test('feed theme carries the current day and week goals beside the main goal', (t) => {
  const root = tempRoot(t);
  const { readScoreboard, writeScoreboard } = require('../commands/goal');
  writeScoreboard({ ...readScoreboard(root), goal: 'big goal', goal_text: 'Big goal' }, root);
  const { _internal } = require('../lib/feed-core');
  assert.equal(_internal.themeText(root), 'Big goal');
  periodGoals.setPeriodGoal(root, 'day', 'today aim');
  periodGoals.setPeriodGoal(root, 'week', 'week aim');
  const theme = require('../lib/feed-core').readTheme(root, { agent: '' });
  assert.equal(theme.text, 'Big goal');
  assert.equal(theme.can_edit, true);
  assert.equal(theme.day.text, 'today aim');
  assert.equal(theme.week.text, 'week aim');
  assert.match(theme.week.week_of, /^\d{4}-\d{2}-\d{2}$/);
  periodGoals.clearPeriodGoal(root, 'day');
  assert.equal(require('../lib/feed-core').readTheme(root, { agent: '' }).day, null);
});

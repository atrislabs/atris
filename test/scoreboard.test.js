'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const { score, cheers, bar, localDate } = require('../commands/scoreboard');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

// Fake gh: answers `gh api graphql` with a calendar. Today's count is read from
// counts.json, one value per call, so --watch sees it climb.
function makeSandbox(todayCounts, history, { oldCommit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scoreboard-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const state = path.join(dir, 'counts.json');
  fs.writeFileSync(state, JSON.stringify(todayCounts));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] !== 'api' || process.argv[3] !== 'graphql') process.exit(1);
const counts = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const today = counts.length > 1 ? counts.shift() : counts[0];
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(counts));
const days = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'history.json'))}, 'utf8'));
days.push({ date: ${JSON.stringify(daysAgo(0))}, contributionCount: today });
process.stdout.write(JSON.stringify({ data: { viewer: { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: days }] } } } } }));
`, { mode: 0o755 });

  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'me');
  if (oldCommit) {
    const when = new Date(Date.now() - 3 * 86400000).toISOString();
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'old work'], {
      cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
  }
  git('commit', '-q', '--allow-empty', '-m', 'mine');
  git('commit', '-q', '--allow-empty', '-m', `member work\n\n${TRAILER}`);
  git('commit', '-q', '--allow-empty', '-m', `more member work\n\n${TRAILER}`);
  return { dir, repo, git, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` } };
}

const HISTORY = [
  { date: daysAgo(3), contributionCount: 0 },
  { date: daysAgo(2), contributionCount: 41 },
  { date: daysAgo(1), contributionCount: 5 },
];

test('score finds best day excluding today and keeps the streak alive on a quiet morning', () => {
  const days = [
    { date: '2026-01-01', count: 9 },
    { date: '2026-01-02', count: 0 },
    { date: '2026-01-03', count: 3 },
    { date: '2026-01-04', count: 4 },
    { date: '2026-01-05', count: 0 },
  ];
  assert.deepStrictEqual(score(days, '2026-01-05'), { today: 0, best: { date: '2026-01-01', count: 9 }, streak: 2 });
  days[4].count = 20;
  assert.deepStrictEqual(score(days, '2026-01-05'), { today: 20, best: { date: '2026-01-01', count: 9 }, streak: 3 });
  // Last year's days never count as this year's best.
  assert.strictEqual(score([{ date: '2025-12-31', count: 99 }, { date: '2026-01-01', count: 1 }], '2026-01-01').best, null);
});

test('cheers fire once per multiple of 50 crossed', () => {
  assert.deepStrictEqual(cheers(10, 49), []);
  assert.deepStrictEqual(cheers(49, 50), ['nice, you passed 50 today. keep pushing.']);
  assert.strictEqual(cheers(40, 160).length, 3);
  assert.deepStrictEqual(cheers(50, 60), []);
  assert.strictEqual(bar(21, 42), '[##########----------]');
});

test('atris scoreboard prints the board from gh and this repo', (t) => {
  if (daysAgo(2).slice(0, 4) !== daysAgo(0).slice(0, 4)) return t.skip('best day falls in last year on jan 1-2');
  const sb = makeSandbox([37], HISTORY);
  try {
    const r = spawnSync(process.execPath, [CLI, 'scoreboard'], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.deepStrictEqual(lines, [
      'today: 37 contributions',
      '[##################--] 5 to beat your best',
      `best day this year: ${daysAgo(2)}, 41`,
      'streak: 3 days',
      'this repo today: 3 commits, you 1, members 2',
    ]);
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('atris scoreboard --json prints the same numbers as one object', (t) => {
  if (daysAgo(2).slice(0, 4) !== daysAgo(0).slice(0, 4)) return t.skip('best day falls in last year on jan 1-2');
  const sb = makeSandbox([37], HISTORY);
  try {
    const r = spawnSync(process.execPath, [CLI, 'scoreboard', '--json'], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), {
      date: daysAgo(0),
      today: 37,
      best: { date: daysAgo(2), count: 41 },
      streak: 3,
      repo: { total: 3, you: 1, members: 2 },
    });
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('atris scoreboard counts today on every branch when an old branch is checked out', () => {
  const sb = makeSandbox([37], HISTORY, { oldCommit: true });
  try {
    // Today's three commits live on the default branch, a feature branch, and a
    // remote branch at once; the checkout sits on a branch from three days ago.
    sb.git('branch', 'feature');
    sb.git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    assert.strictEqual(sb.git('checkout', '-q', '-b', 'old', 'HEAD~3').status, 0);
    // A stash made today is work in progress, not a commit.
    fs.writeFileSync(path.join(sb.repo, 'wip.txt'), 'wip');
    assert.strictEqual(sb.git('stash', 'push', '-q', '-u', '-m', 'wip').status, 0);
    for (const args of [['scoreboard'], ['scoreboard', '--json']]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      if (args[1]) assert.deepStrictEqual(JSON.parse(r.stdout).repo, { total: 3, you: 1, members: 2 });
      else assert.match(r.stdout, /this repo today: 3 commits, you 1, members 2/);
    }
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('atris scoreboard fails plainly when gh is missing or broken', () => {
  const sb = makeSandbox([1], HISTORY);
  try {
    fs.writeFileSync(path.join(sb.dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = spawnSync(process.execPath, [CLI, 'scoreboard'], { cwd: sb.repo, env: sb.env, encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /could not read your github contributions/);
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('atris scoreboard --watch refreshes and cheers when today crosses 50', async () => {
  const sb = makeSandbox([48, 52, 55], HISTORY);
  try {
    const env = { ...sb.env, ATRIS_SCOREBOARD_INTERVAL_MS: '20', ATRIS_SCOREBOARD_TICKS: '2' };
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'scoreboard', '--watch'], { cwd: sb.repo, env });
      let buf = '';
      child.stdout.on('data', (c) => { buf += c; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}`))));
    });
    assert.match(out, /today: 48 contributions/);
    assert.match(out, /today: 52 contributions/);
    assert.match(out, /today: 55 contributions/);
    assert.strictEqual(out.match(/nice, you passed 50 today/g).length, 1);
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scoreboardCommand } = require('../commands/scoreboard');

// Real, local executables keep the command away from GitHub and the host repo.
// Empty calendar data makes the text output independent of the local date.
async function runCommand(args, { calendar = true, commits = '', gitFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scoreboard-command-'));
  const keys = ['HOME', 'PATH', 'ATRIS_SCOREBOARD_INTERVAL_MS', 'ATRIS_SCOREBOARD_TICKS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  try {
    const payload = calendar
      ? JSON.stringify({ data: { viewer: { contributionsCollection: { contributionCalendar: { weeks: [] } } } } })
      : 'invalid json';
    for (const [name, body] of [
      ['gh', `process.stdout.write(${JSON.stringify(payload)});`],
      ['git', gitFails ? 'process.exit(1);' : `process.stdout.write(${JSON.stringify(commits)});`],
    ]) {
      fs.writeFileSync(path.join(root, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    }
    process.env.HOME = root;
    process.env.PATH = root;
    delete process.env.ATRIS_SCOREBOARD_INTERVAL_MS;
    delete process.env.ATRIS_SCOREBOARD_TICKS;
    console.log = (...values) => stdout.push(values.join(' '));
    console.error = (...values) => stderr.push(values.join(' '));
    const code = await scoreboardCommand(args);
    return { code, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const emptyBoard = [
  'today: 0 contributions',
  'best day this year: none yet, today sets it',
  'streak: 0 days',
];

test('scoreboardCommand renders local commits and attributes member commits', async () => {
  const commits = 'abc\x1fpersonal change\x1e\ndef\x1fmember change\natris-builder[bot]@users.noreply.github.com\x1e\n';
  assert.deepStrictEqual(await runCommand([], { commits }), {
    code: 0,
    stdout: [[...emptyBoard, 'this repo today: 2 commits, you 1, members 1'].join('\n')],
    stderr: [],
  });
});

test('scoreboardCommand renders an empty calendar and repository', async () => {
  assert.deepStrictEqual(await runCommand([]), {
    code: 0,
    stdout: [[...emptyBoard, 'this repo today: 0 commits, you 0, members 0'].join('\n')],
    stderr: [],
  });
});

test('scoreboardCommand tolerates an unavailable git repository', async () => {
  assert.deepStrictEqual(await runCommand([], { gitFails: true }), {
    code: 0,
    stdout: [[...emptyBoard, 'this repo today: not a git repo'].join('\n')],
    stderr: [],
  });
});

test('scoreboardCommand reports malformed contribution data', async () => {
  assert.deepStrictEqual(await runCommand([], { calendar: false }), {
    code: 1,
    stdout: [],
    stderr: ['could not read your github contributions. check that gh is installed and logged in (gh auth status).'],
  });
});

test('scoreboardCommand help takes precedence over json and watch', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCommand([flag, '--json', '--watch'], { calendar: false });
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(result.stderr, []);
    assert.deepStrictEqual(result.stdout, [
      'usage: atris scoreboard [--watch | --json]',
      "  today's github contributions, your best day this year, your streak, and this repo's commits",
      '  --watch   refresh every 60 seconds and cheer at every 50',
      '  --json    print the same numbers once as one json object',
    ]);
  }
});

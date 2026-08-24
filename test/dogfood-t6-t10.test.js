'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { formatCalendarEvents } = require('../commands/integrations');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-dogfood-t6-t10-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

test('T6: code-review missing engine says not installed and exits 2', () => {
  const dir = makeTempDir();
  try {
    const human = runCli(['code-review', 'example.py'], { cwd: dir });
    assert.equal(human.status, 2);
    assert.match(human.stderr, /not installed; atris skill install code-review/);
    assert.doesNotMatch(human.stderr + human.stdout, /Traceback/);

    const json = runCli(['code-review', '--json'], { cwd: dir });
    assert.equal(json.status, 2);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not installed');
    assert.match(body.install, /atris skill install code-review/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T7: xp defaults to --local when no bound business', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'task_episodes.jsonl'), '');
    // Fake login so the old cloud path would otherwise try the network.
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'fake-token',
      email: 'dogfood@example.com',
    }));

    const result = runCli(['xp', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.schema, 'atris.career_xp_projection.v1');
    assert.doesNotMatch(result.stderr, /Failed to load XP graph|404/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T7: xp still uses cloud path when business is bound and --local is absent', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz_dogfood',
      slug: 'dogfood-co',
    }));
    const result = runCli(['xp'], { cwd: dir });
    // No credentials + bound business -> login hint (cloud path), not silent local.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Not logged in|login|--local/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T8: calendar empty-day copy is a real sentence', () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    formatCalendarEvents("today's events", []);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(lines, ["No today's events."]);
  assert.doesNotMatch(lines.join('\n'), /No events today's events/);
});

test('T9: top-level lesson help matches real argv; lesson --help prints schema', () => {
  const help = runCli(['help', '--all']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /lesson\s+- atris lesson add <slug> <pass\|fail>/);
  assert.doesNotMatch(help.stdout, /Append a one-line lesson/);

  const lessonHelp = runCli(['lesson', '--help']);
  assert.equal(lessonHelp.status, 0, lessonHelp.stderr);
  assert.match(lessonHelp.stdout, /Usage: atris lesson add <slug> <pass\|fail>/);
  assert.match(lessonHelp.stdout, /lesson mine/);
  assert.match(lessonHelp.stdout, /lesson ledger/);
});

test('T10: founder --json emits JSON scorecard', () => {
  const dir = makeTempDir();
  try {
    const run = runCli(['founder', '--json', '--root', dir], {
      cwd: dir,
      env: { ATRIS_FOUNDER_NOW: '2026-08-10T08:00:00.000Z' },
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const body = JSON.parse(run.stdout);
    assert.equal(typeof body.commitsThisWeek, 'number');
    assert.equal(typeof body.commitsLastWeek, 'number');
    assert.equal(typeof body.slopePct, 'number');
    assert.ok(Array.isArray(body.perRepo));
  } finally {
    cleanupTempDir(dir);
  }
});

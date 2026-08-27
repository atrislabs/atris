'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { spokenLineCount } = require('../lib/first-minute');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 12000;
const MACHINERY = /always-on|budget:|tick:|interval |runtime|session|receipt|orchestration|pipeline|survives bad ticks|spaceship plan|Usage: atris autopilot/i;

function makeTempDir(prefix = 'atris-hours-lingo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function isolatedEnv(dir, extra = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_HOME: home,
    USER: 'keshav',
    ATRIS_OPERATOR: 'keshav',
    ...extra,
  };
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ') || '(none)'})`);
  }
  if (result.error) throw result.error;
  return result;
}

function combined(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function assertNoMint(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'must not mint .atris/');
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'must not mint atris/');
}

function writeRoom(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
}

function writeHoursMission(dir) {
  fs.writeFileSync(
    path.join(dir, '.atris', 'state', 'missions.jsonl'),
    `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-hours',
      objective: 'Explore the world for hours',
      owner: 'mission-lead',
      status: 'ready',
      runner: 'atris2',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    })}\n`,
  );
}

test('spaceship without --yes talks keep-working English in an empty folder', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['spaceship'], { cwd: dir, env });
    assert.equal(res.status, 2, combined(res));
    assert.match(res.stdout, /hey keshav, I can keep working here for 4 hours\./);
    assert.match(res.stdout, /I'll write you if something changes\. next: atris spaceship --yes/);
    assert.equal(spokenLineCount(res.stdout), 2);
    assert.doesNotMatch(combined(res), MACHINERY);
    assert.doesNotMatch(combined(res), /spaceship start:|EMAIL FAILED|EMAIL sent/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('spaceship honors --hours and --no-email in a room', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  writeRoom(dir);
  try {
    const hours = runCli(['spaceship', '--hours', '1'], { cwd: dir, env });
    assert.equal(hours.status, 2, combined(hours));
    assert.match(hours.stdout, /I can keep working here for 1 hour\./);
    assert.match(hours.stdout, /I'll write you if something changes\. next: atris spaceship --yes/);
    assert.equal(spokenLineCount(hours.stdout), 2);

    const quiet = runCli(['spaceship', '--no-email', '--hours', '8'], { cwd: dir, env });
    assert.equal(quiet.status, 2, combined(quiet));
    assert.match(quiet.stdout, /I can keep working here for 8 hours\./);
    assert.doesNotMatch(quiet.stdout, /I'll write you/);
    assert.match(quiet.stdout, /^next: atris spaceship --yes$/m);
    assert.equal(spokenLineCount(quiet.stdout), 2);
    assert.doesNotMatch(combined(hours) + combined(quiet), /spaceship start:|EMAIL FAILED|EMAIL sent/i);
  } finally {
    cleanup(dir);
  }
});

test('spaceship --help stays short usage in those words', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['spaceship', '--help'], { cwd: dir, env });
    assert.equal(res.status, 0, combined(res));
    assert.match(res.stdout, /Usage: atris spaceship/);
    assert.match(res.stdout, /--hours/);
    assert.match(res.stdout, /--interval/);
    assert.match(res.stdout, /--no-email/);
    assert.match(res.stdout, /Keep working here for a few hours/);
    assert.doesNotMatch(res.stdout, /survives bad ticks/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('autopilot without --yes talks keep-working English in a room', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  writeRoom(dir);
  try {
    const res = runCli(['autopilot'], { cwd: dir, env });
    assert.equal(res.status, 2, combined(res));
    assert.match(res.stdout, /hey keshav, I can keep working until you stop\./);
    assert.match(res.stdout, /^next: atris autopilot --yes$/m);
    assert.equal(spokenLineCount(res.stdout), 2);
    assert.doesNotMatch(combined(res), MACHINERY);
    assert.doesNotMatch(combined(res), /Autopilot on|Takeoff|mission_started/i);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'autopilot.json')), false);
  } finally {
    cleanup(dir);
  }
});

test('autopilot --help stays usage', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  writeRoom(dir);
  try {
    const res = runCli(['autopilot', '--help'], { cwd: dir, env });
    assert.equal(res.status, 0, combined(res));
    assert.match(res.stdout, /Usage: atris autopilot/);
    assert.match(res.stdout, /--yes/);
    assert.doesNotMatch(res.stdout, /Autopilot on|Takeoff/i);
  } finally {
    cleanup(dir);
  }
});

test('run with no objective talks like bare atris and does not resume hours work', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  writeRoom(dir);
  writeHoursMission(dir);
  const before = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
  try {
    const desk = runCli([], { cwd: dir, env });
    const res = runCli(['run'], { cwd: dir, env });
    assert.equal(res.status, desk.status, combined(res));
    assert.equal(res.stdout.trim(), desk.stdout.trim());
    assert.doesNotMatch(combined(res), /Resuming mission|Explore the world for hours|mission-hours/i);
    assert.doesNotMatch(combined(res), /no runnable mission|atris run "<objective>"/i);
    assert.equal(fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8'), before);
  } finally {
    cleanup(dir);
  }
});

test('empty-folder mission stays first-minute; leftover mission hi does not mint', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const minute = runCli([], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    assert.equal(mission.status, minute.status, combined(mission));
    assert.equal(mission.stdout.trim(), minute.stdout.trim());
    assert.match(mission.stdout, /hey keshav, this folder is empty\./);

    const leftover = runCli(['mission', 'hi'], { cwd: dir, env });
    assert.notEqual(leftover.status, undefined);
    assert.doesNotMatch(combined(leftover), /mission_started|Takeoff|spaceship start/i);
    assertNoMint(dir);

    const quoted = runCli(['mission hi'], { cwd: dir, env });
    assert.equal(quoted.status, minute.status, combined(quoted));
    assert.equal(quoted.stdout.trim(), minute.stdout.trim());
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

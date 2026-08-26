'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  UNBOUND_SCRATCH_MESSAGE,
  isUnboundScratchFolder,
} = require('../lib/scratch-root');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 8000;

function makeScratch(prefix = 'atris-xx-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function isolatedEnv(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_HOME: home,
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

test('unbound scratch spaceship --yes refuses and does not start', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    assert.equal(isUnboundScratchFolder(dir), true, 'empty tmp child must be unbound scratch');

    const res = runCli(['spaceship', '--yes'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const out = combined(res);
    assert.equal(out.includes(UNBOUND_SCRATCH_MESSAGE), true);
    assert.doesNotMatch(out, /spaceship start:|spaceship plan|EMAIL FAILED|EMAIL sent|tick 1 start/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('unbound scratch autopilot --yes refuses and does not mint', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['autopilot', '--yes'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const out = combined(res);
    assert.equal(out.includes(UNBOUND_SCRATCH_MESSAGE), true);
    assert.doesNotMatch(out, /Autopilot on|Takeoff|mission_started|self-chosen mission/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('unbound scratch spaceship without --yes still prints the plan only', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['spaceship'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /spaceship plan \(no run\)/);
    assert.match(res.stdout, /Pass --yes to start the overnight run/);
    assert.doesNotMatch(combined(res), /this folder is not a room|spaceship start:|EMAIL FAILED|tick 1 start/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('unbound scratch autopilot --json still JSON and does not start', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['autopilot', '--json'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.command, 'autopilot');
    assert.equal(body.running, false);
    assert.match(String(body.error || ''), /--yes|usage/i);
    assert.doesNotMatch(combined(res), /this folder is not a room|Autopilot on|Takeoff/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('unbound scratch spaceship --json still JSON and does not start', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['spaceship', '--json'], { cwd: dir, env });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.command, 'spaceship');
    assert.equal(body.running, false);
    assert.equal(body.error, 'pass --yes to start');
    assert.doesNotMatch(combined(res), /this folder is not a room|spaceship start:|EMAIL FAILED|tick 1 start/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('unbound scratch spaceship and autopilot --help stay usage', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const ship = runCli(['spaceship', '--help'], { cwd: dir, env });
    assert.equal(ship.status, 0, ship.stdout + ship.stderr);
    assert.match(ship.stdout, /Usage: atris spaceship/);
    assert.doesNotMatch(combined(ship), /this folder is not a room|spaceship start:|EMAIL FAILED/i);

    const auto = runCli(['autopilot', '--help'], { cwd: dir, env });
    assert.equal(auto.status, 0, auto.stdout + auto.stderr);
    assert.match(auto.stdout, /Usage: atris autopilot/);
    assert.doesNotMatch(combined(auto), /this folder is not a room|Autopilot on/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('bound workspace under tmp can still start spaceship --yes', () => {
  const dir = makeScratch('atris-bound-');
  const env = isolatedEnv(dir);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  try {
    assert.equal(isUnboundScratchFolder(dir), false, 'atris/ makes a scratch child a room');

    const res = runCli([
      'spaceship',
      '--yes',
      '--no-email',
      '--hours', '0.001',
      '--interval', '1',
      '--tick-cmd', 'true',
      '--tick-timeout', '2',
    ], { cwd: dir, env, timeout: 15000 });
    assert.notEqual(res.status, 2, res.stdout + res.stderr);
    assert.match(combined(res), /spaceship start:/);
    assert.doesNotMatch(combined(res), /this folder is not a room/);
  } finally {
    cleanup(dir);
  }
});

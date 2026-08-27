'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { spokenLineCount } = require('../lib/first-minute');
const {
  UNBOUND_SCRATCH_MESSAGE,
  isUnboundScratchFolder,
} = require('../lib/scratch-root');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeScratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-nomint-')));
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
    USER: 'keshav',
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

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
}

function assertNoMint(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'must not mint .atris/');
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'must not mint atris/');
}

function assertFirstMinute(result, minute) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), minute.stdout.trim());
  assert.match(result.stdout, /this folder is empty/);
  assert.equal(nextLine(result.stdout), 'atris "what do you want here?"');
  assert.equal(spokenLineCount(result.stdout), spokenLineCount(minute.stdout));
  assert.doesNotMatch(result.stdout, /I saved a first step|atris task claim |No open tasks|atris task new/);
}

test('unbound scratch task next speaks first-minute and does not mint', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    assert.equal(isUnboundScratchFolder(dir), true, 'empty tmp child must be unbound scratch');

    const minute = runCli([], { cwd: dir, env });
    assert.equal(minute.status, 0, minute.stderr || minute.stdout);
    assertNoMint(dir);

    const next = runCli(['task', 'next'], { cwd: dir, env });
    assertFirstMinute(next, minute);
    assertNoMint(dir);

    const quoted = runCli(['task next'], { cwd: dir, env });
    assertFirstMinute(quoted, minute);
    assertNoMint(dir);

    const wish = runCli(['wish', 'count words'], { cwd: dir, env });
    assertFirstMinute(wish, minute);
    assertNoMint(dir);

    const brainstorm = runCli(['brainstorm', 'count words'], { cwd: dir, env });
    assertFirstMinute(brainstorm, minute);
    assertNoMint(dir);

    const leftoverHi = runCli(['brainstorm', 'hi'], { cwd: dir, env });
    assertFirstMinute(leftoverHi, minute);
    assertNoMint(dir);

    for (const leftover of ['brainstorm hi', 'wish hi', 'log hi', 'plan hi', 'do hi']) {
      const quoted = runCli([leftover], { cwd: dir, env });
      assertFirstMinute(quoted, minute);
      assertNoMint(dir);
    }

    const help = runCli(['task', 'next', '--help'], { cwd: dir, env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris task next/);
    assert.doesNotMatch(help.stdout, /this folder is empty|I saved a first step/);
    assertNoMint(dir);

    const ship = runCli(['spaceship', '--yes'], { cwd: dir, env });
    assert.equal(ship.status, 2, ship.stdout + ship.stderr);
    assert.equal(`${ship.stdout}\n${ship.stderr}`.includes(UNBOUND_SCRATCH_MESSAGE), true);
    assert.doesNotMatch(`${ship.stdout}\n${ship.stderr}`, /spaceship start:|EMAIL sent|tick 1 start/i);
    assertNoMint(dir);

    const auto = runCli(['autopilot', '--yes'], { cwd: dir, env });
    assert.equal(auto.status, 2, auto.stdout + auto.stderr);
    assert.equal(`${auto.stdout}\n${auto.stderr}`.includes(UNBOUND_SCRATCH_MESSAGE), true);
    assert.doesNotMatch(`${auto.stdout}\n${auto.stderr}`, /Autopilot on|Takeoff|mission_started/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('talk line still starts a room and task next then names the claim', () => {
  const dir = makeScratch();
  const env = isolatedEnv(dir);
  try {
    const talk = runCli(['what do you want here?'], { cwd: dir, env, timeout: 60000 });
    assert.equal(talk.status, 0, talk.stderr || talk.stdout);
    assert.match(talk.stdout, /this folder is ready\./);
    assert.doesNotMatch(talk.stdout, /I saved a first step|first useful step/i);
    assert.match(nextLine(talk.stdout), /^atris task claim \S+ --as keshav$/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), true);

    const next = runCli(['task', 'next'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    assert.match(nextLine(next.stdout), /^atris task (claim|show|ready) /);
    assert.doesNotMatch(next.stdout, /this folder is empty|atris task new/);

    const wish = runCli(['wish', 'hi', '--no-mission'], { cwd: dir, env: { ...env, ATRIS_WISH_NO_DRIVER: '1' } });
    assert.match(wish.stdout, /Got it: "hi"\./);
    assert.doesNotMatch(wish.stdout, /this folder is empty|I saved a first step/);

    const brainstorm = runCli(['brainstorm', 'hi'], { cwd: dir, env });
    assert.equal(brainstorm.status, 0, brainstorm.stderr || brainstorm.stdout);
    assert.match(brainstorm.stdout, /captured I\d+: hi/);
    assert.doesNotMatch(brainstorm.stdout, /this folder is empty|I saved a first step|Describe the desired outcome/);
  } finally {
    cleanup(dir);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 12000;

function makeTempDir(prefix = 'atris-dogfood-p0-safety-') {
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
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function assertNoMissionSpawn(dir) {
  const missions = path.join(dir, '.atris', 'state', 'missions.jsonl');
  assert.equal(fs.existsSync(missions), false, 'must not create missions.jsonl');
}

test('23: atris start and atris go exit 2 without spawning a runner', () => {
  const dir = makeTempDir();
  try {
    for (const verb of ['start', 'go', 'audit', 'deploy', 'keepgoing']) {
      const res = runCli([verb], { cwd: dir });
      assert.equal(res.status, 2, `${verb}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr + res.stdout, /Unknown command|Did you mean|atris help/i);
      assert.doesNotMatch(res.stdout, /Takeoff|mission_started|Bounded Proof/i);
    }
    assertNoMissionSpawn(dir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('24: invite --help prints usage and does not mint invites', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-dogfood-home-');
  try {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    const res = runCli(['invite', '--help'], {
      cwd: dir,
      env: { HOME: home },
    });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /Usage|invite/i);
    assert.doesNotMatch(res.stdout + res.stderr, /atris\.ai\/invite\/|Invite link/i);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('24: msg/follow/skill link/plugin publish --help do not treat help as a name', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);

    for (const args of [
      ['msg', '--help'],
      ['follow', '--help'],
      ['skill', 'link', '--help'],
      ['plugin', 'publish', '--help'],
    ]) {
      const res = runCli(args, { cwd: dir });
      assert.ok(res.status === 0 || res.status === 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Publishing to|Linked to|No one found for "--help"|Could not find "--help"/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('25: bare spaceship plans only; no overnight run', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['spaceship'], { cwd: dir });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /spaceship plan|Pass --yes|Usage: atris spaceship/i);
    assert.doesNotMatch(res.stdout + res.stderr, /spaceship start:|EMAIL FAILED|tick 1 start/i);
    assert.equal(fs.existsSync(path.join(dir, 'atris', '.spaceship')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('25: serve/dream/scout/interview refuse headless without proceed flag', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);

    for (const args of [
      ['serve'],
      ['dream'],
      ['scout', 'where is MAP'],
      ['interview'],
    ]) {
      const res = runCli(args, { cwd: dir, timeout: 8000 });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr + res.stdout, /Usage|Headless|--yes|--once/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('25: improve --dry-run --json does not call the paid endpoint', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    const home = makeTempDir('atris-dogfood-improve-home-');
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    const res = runCli(['improve', '--dry-run', '--json'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
      },
      timeout: 8000,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.reason, 'dry_run');
    assert.equal(body.source, 'local');
    assert.equal(body.receipt, 'skipped');
  } finally {
    cleanupTempDir(dir);
  }
});

test('26: atris stop from unbound folder exits 2 without stopping cloud work', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-dogfood-stop-home-');
  try {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    const res = runCli(['stop'], {
      cwd: dir,
      env: {
        HOME: home,
        ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
      },
    });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout + res.stderr, /cloud-computer|--mission/i);
    assert.doesNotMatch(res.stdout + res.stderr, /\bStopped\b|703h|ship the launch/i);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('29: join --help prints usage and does not look up an invite', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-dogfood-join-home-');
  try {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    for (const args of [
      ['join', '--help'],
      ['join', '-h'],
      ['join', 'help'],
      ['social', 'join', '--help'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: {
          HOME: home,
          ATRIS_API_URL: 'http://127.0.0.1:9',
        },
        timeout: 8000,
      });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris join/i);
      assert.doesNotMatch(res.stdout + res.stderr, /invite does not exist|expired|Invite from|You're in/i);
    }
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('29: friends/inbox --help print usage and do not hit social or inbox APIs', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-dogfood-inbox-home-');
  try {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    for (const args of [
      ['friends', '--help'],
      ['friends', 'help'],
      ['inbox', '--help'],
      ['inbox', 'help'],
      ['social', 'friends', '--help'],
      ['social', 'inbox', '--help'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: {
          HOME: home,
          ATRIS_API_URL: 'http://127.0.0.1:9',
        },
        timeout: 8000,
      });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris (friends|inbox)/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Session expired|Conversations|No friends yet|No conversations/i);
    }
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('29: signup help prints usage and does not mint or solve proof-of-work', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['signup', 'help'],
      ['signup', '--help'],
      ['signup', '-h'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: {
          ATRIS_API_URL: 'http://127.0.0.1:9',
        },
        timeout: 4000,
      });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris signup/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Claiming @|proof-of-work|already taken/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('30: typo plus extra args exits 2 and does not create a task', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    const beforeTodo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');

    for (const args of [
      ['taks', 'list'],
      ['misson', 'status'],
      ['xyzzy', 'now'],
    ]) {
      const res = runCli(args, { cwd: dir });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr + res.stdout, /Unknown command/i);
      assert.doesNotMatch(res.stdout, /Got it\. I saved|First task:|Focus: taks list|Focus: misson status/i);
    }

    const typoJson = runCli(['taks', 'list', '--json'], { cwd: dir });
    assert.equal(typoJson.status, 2, typoJson.stdout + typoJson.stderr);
    assert.equal(JSON.parse(typoJson.stdout).error, 'unknown command: taks');

    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'context_profile.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8'), beforeTodo);

    const quoted = runCli(['fix the login', '--json'], { cwd: dir });
    const payload = JSON.parse(quoted.stdout);
    assert.notEqual(payload.error, 'unknown command: fix the login');
    assert.notEqual(payload.command, 'fix the login');
  } finally {
    cleanupTempDir(dir);
  }
});

test('31: avail --help prints usage and does not authenticate', () => {
  const dir = makeTempDir();
  const home = makeTempDir('atris-dogfood-avail-home-');
  try {
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
      token: 'test-token',
      email: 'dogfood@example.com',
      user_id: 'u-1',
    }), 'utf8');

    for (const args of [
      ['avail', '--help'],
      ['avail', '-h'],
      ['avail', 'help'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: {
          HOME: home,
          ATRIS_API_URL: 'http://127.0.0.1:9',
          ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
        },
        timeout: 4000,
      });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris avail/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Authentication failed|ECONNREFUSED|Booking availability/i);
    }
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('33: leftover _start exits 2 without spawning a runner', () => {
  const dir = makeTempDir();
  try {
    for (const verb of ['_start', 'start']) {
      const res = runCli([verb], { cwd: dir });
      assert.equal(res.status, 2, `${verb}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stderr + res.stdout, /Unknown command|Did you mean|atris help/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Takeoff|mission_started|Bounded Proof|start_mission_run/i);
    }
    assertNoMissionSpawn(dir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('33: help and --help do not write workspace state', () => {
  const dir = makeTempDir();
  try {
    for (const args of [['help'], ['--help'], ['help', '--all'], ['help', '--json']]) {
      const res = runCli(args, { cwd: dir });
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
    }
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'help must not create .atris');
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'help must not scaffold atris/');
  } finally {
    cleanupTempDir(dir);
  }
});

test('32: headless autopilot exits 2 without starting a mission', () => {
  const dir = makeTempDir();
  try {
    assert.equal(runCli(['init', '--yes', '--minimal'], { cwd: dir, timeout: 60000 }).status, 0);
    const res = runCli(['autopilot'], { cwd: dir, timeout: 5000 });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr + res.stdout, /Usage: atris autopilot|Headless|Pass --yes/i);
    assert.doesNotMatch(res.stdout + res.stderr, /Takeoff|Autopilot on|Bounded Proof|mission_started/i);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'autopilot.json')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('33: x --help prints usage and does not start agent-sdk execute', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['x', '--help'],
      ['x', '-h'],
      ['x', 'help'],
    ]) {
      const res = runCli(args, {
        cwd: dir,
        env: {
          ATRIS_API_URL: 'http://127.0.0.1:9',
          ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
        },
        timeout: 4000,
      });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /Usage: atris x/i);
      assert.doesNotMatch(res.stdout + res.stderr, /Executing:|ECONNREFUSED 127\.0\.0\.1:8000|\/api\/agent-sdk\/execute/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('34: write start help prints usage and does not create a session', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['write', 'start', 'help'],
      ['write', 'start', '--help'],
      ['write', 'start', '-h'],
    ]) {
      const res = runCli(args, { cwd: dir, timeout: 4000 });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      assert.match(res.stdout + res.stderr, /usage: atris write start/i);
      assert.doesNotMatch(res.stdout + res.stderr, /session started/i);
    }
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'writing', 'help')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'writing')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

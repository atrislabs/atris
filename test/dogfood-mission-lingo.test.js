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
const FACTORY = /durable goal|Autonomy recipe|Backend\/web agents|missions\.jsonl|codex_goal|native-goal|always-on|attach-task --json|UNVERIFIED|Run the next proof step/i;
const MACHINERY = /always-on|tick|proof|runtime|session|receipt|orchestration|process|stage|pipeline|mission-80|mission-done/i;

function makeTempDir(prefix = 'atris-mission-lingo-') {
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
    ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
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

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
}

function assertNoMint(dir) {
  assert.equal(fs.existsSync(path.join(dir, '.atris')), false, 'must not mint .atris/');
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false, 'must not mint atris/');
}

function writeReadyRoom(dir) {
  fs.mkdirSync(path.join(dir, 'atris', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [{
      id: 'task-map',
      display_id: 'CLI-193',
      title: 'write a feature map for the live room',
      status: 'review',
      review: { agent_certified: true, agent_review_pass_count: 2 },
      created_at: 1,
      updated_at: 2,
    }],
  }, null, 2), 'utf8');
}

function writeArchive(dir) {
  const old = '2026-01-01T00:00:00Z';
  fs.writeFileSync(
    path.join(dir, '.atris', 'state', 'missions.jsonl'),
    `${[
      {
        schema: 'atris.mission.v1',
        id: 'mission-done',
        objective: 'Ship the old pack',
        owner: 'executor',
        status: 'complete',
        created_at: old,
        updated_at: old,
      },
      {
        schema: 'atris.mission.v1',
        id: 'mission-80',
        n: 80,
        objective: 'Explore the world for hours',
        owner: 'executor',
        status: 'ready',
        created_at: old,
        updated_at: old,
        last_tick_at: old,
      },
    ].map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

test('mission --help is a short keep-working page', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['mission', '--help'], { cwd: dir, env });
    assert.equal(res.status, 0, combined(res));
    assert.match(res.stdout, /Usage: atris mission/);
    assert.match(res.stdout, /Keep working on one goal/);
    assert.match(res.stdout, /atris mission start/);
    assert.match(res.stdout, /atris mission status/);
    assert.match(res.stdout, /atris mission stop/);
    assert.match(res.stdout, /atris mission list/);
    assert.match(res.stdout, /atris spaceship/);
    assert.match(res.stdout, /atris autopilot/);
    assert.match(res.stdout, /atris mission help --full/);
    assert.doesNotMatch(res.stdout, FACTORY);
    assert.doesNotMatch(res.stdout, /always-on|native-goal|missions\.jsonl|Backend\/web/);
    const lines = res.stdout.split(/\n/).filter((line) => line.trim());
    assert.ok(lines.length <= 16, res.stdout);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('mission help --full still dumps the long page', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const res = runCli(['mission', 'help', '--full'], { cwd: dir, env });
    assert.equal(res.status, 0, combined(res));
    assert.match(res.stdout, /Autonomy recipe:/);
    assert.match(res.stdout, /Backend\/web agents:/);
    assert.doesNotMatch(res.stdout, /Keep working on one goal/);
  } finally {
    cleanup(dir);
  }
});

test('empty-folder mission status and list talk like first-minute', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    const minute = runCli([], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    const status = runCli(['mission', 'status'], { cwd: dir, env });
    const listed = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(mission.stdout.trim(), minute.stdout.trim(), combined(mission));
    assert.equal(status.stdout.trim(), minute.stdout.trim(), combined(status));
    assert.equal(listed.stdout.trim(), minute.stdout.trim(), combined(listed));
    assert.match(status.stdout, /hey keshav, this folder is empty\./);
    assert.match(status.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(combined(status) + combined(listed), /No missions yet|mission start|--owner/);
    assertNoMint(dir);

    const leftover = runCli(['mission', 'hi'], { cwd: dir, env });
    assert.doesNotMatch(combined(leftover), /mission_started|Takeoff|spaceship start/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

test('live-room default status matches bare mission; list keeps the archive', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    writeReadyRoom(dir);
    writeArchive(dir);
    const minute = runCli([], { cwd: dir, env });
    const mission = runCli(['mission'], { cwd: dir, env });
    const status = runCli(['mission', 'status'], { cwd: dir, env });
    assert.equal(mission.stdout.trim(), minute.stdout.trim(), combined(mission));
    assert.equal(status.stdout.trim(), minute.stdout.trim(), combined(status));
    assert.match(status.stdout, /something finished\. waiting on you\./);
    assert.equal(nextLine(status.stdout), nextLine(minute.stdout));
    assert.match(nextLine(status.stdout), /^atris task accept CLI-193$/);
    assert.equal(spokenLineCount(status.stdout), spokenLineCount(minute.stdout));
    assert.doesNotMatch(status.stdout, MACHINERY);
    assert.doesNotMatch(status.stdout, /Ship the old pack|Explore the world|No missions yet|attach-task/);

    const listed = runCli(['mission', 'list'], { cwd: dir, env });
    assert.equal(listed.status, 0, combined(listed));
    assert.match(listed.stdout, /Ship the old pack|mission-done/);
    assert.match(listed.stdout, /Explore the world|mission-80/);

    const all = runCli(['mission', 'status', '--all'], { cwd: dir, env });
    assert.equal(all.status, 0, combined(all));
    assert.match(all.stdout, /Ship the old pack|mission-done/);
    assert.match(all.stdout, /Explore the world|mission-80/);
  } finally {
    cleanup(dir);
  }
});

test('mission verb --help stays usage; hours --yes still refuse in an empty folder', () => {
  const dir = makeTempDir();
  const env = isolatedEnv(dir);
  try {
    for (const args of [
      ['mission', 'status', '--help'],
      ['mission', 'stop', '--help'],
      ['mission', 'list', '--help'],
      ['mission', 'run', '--help'],
    ]) {
      const res = runCli(args, { cwd: dir, env });
      assert.equal(res.status, 0, `${args.join(' ')}: ${combined(res)}`);
      assert.match(res.stdout, /^Usage: atris mission /);
      assert.doesNotMatch(res.stdout, /Keep working on one goal|Autonomy recipe/);
    }

    const ship = runCli(['spaceship', '--yes'], { cwd: dir, env });
    assert.equal(ship.status, 2, combined(ship));
    assert.match(combined(ship), /this folder is not a room/);
    assert.doesNotMatch(combined(ship), /spaceship start:|EMAIL sent/i);

    const auto = runCli(['autopilot', '--yes'], { cwd: dir, env });
    assert.equal(auto.status, 2, combined(auto));
    assert.match(combined(auto), /this folder is not a room/);
    assert.doesNotMatch(combined(auto), /Autopilot on|Takeoff|mission_started/i);
    assertNoMint(dir);
  } finally {
    cleanup(dir);
  }
});

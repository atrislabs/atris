'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-number-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function missionsPath(dir) {
  return path.join(dir, '.atris', 'state', 'missions.jsonl');
}

function appendMission(dir, mission) {
  const file = missionsPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    schema: 'atris.mission.v1',
    objective: mission.id,
    owner: 'mission-lead',
    runner: 'manual',
    cadence: 'manual',
    lane: 'workspace',
    task_ids: [],
    human_asks: [],
    next_action: 'record the next tick',
    created_at: '2026-07-10T10:00:00.000Z',
    updated_at: '2026-07-10T10:00:00.000Z',
    ...mission,
  })}\n`, 'utf8');
}

function readMissions(dir) {
  return fs.readFileSync(missionsPath(dir), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('mission number is assigned once across saves and remains usable for tick', () => {
  const dir = makeWorkspace();
  try {
    const started = runCli([
      'mission', 'start', '--no-verify', 'keep mission number stable',
      '--owner', 'mission-lead', '--runner', 'manual', '--json',
    ], dir);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    for (let index = 1; index <= 3; index += 1) {
      const updated = runCli(['mission', 'ping', `#${mission.n}`, `update ${index}`], dir);
      assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    }

    const beforeTick = readMissions(dir).filter((row) => row.id === mission.id);
    assert.equal(beforeTick.length, 4);
    assert.deepEqual(beforeTick.map((row) => row.n), [mission.n, mission.n, mission.n, mission.n]);

    const ticked = runCli(['mission', 'tick', `#${mission.n}`, '--summary', 'number stayed stable', '--json'], dir);
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
    assert.equal(JSON.parse(ticked.stdout).mission.id, mission.id);
    assert.ok(readMissions(dir).filter((row) => row.id === mission.id).every((row) => row.n === mission.n));
  } finally {
    cleanup(dir);
  }
});

test('drifted mission history lists and resolves by its first assigned number', () => {
  const dir = makeWorkspace();
  try {
    appendMission(dir, { id: 'mission-drifted', n: 10, status: 'planning' });
    appendMission(dir, { id: 'mission-drifted', n: 11, status: 'running', updated_at: '2026-07-10T11:00:00.000Z' });
    appendMission(dir, { id: 'mission-drifted', status: 'blocked', updated_at: '2026-07-10T12:00:00.000Z' });

    const listed = runCli(['mission', 'list', '--local'], dir);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /Mission: #10 mission drifted/);
    assert.doesNotMatch(listed.stdout, /Mission: #(?:11|12) mission drifted/);

    const resolved = runCli(['mission', 'status', '#10', '--json'], dir);
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    const mission = JSON.parse(resolved.stdout).missions[0];
    assert.equal(mission.id, 'mission-drifted');
    assert.equal(mission.n, 10);
    assert.equal(mission.status, 'blocked');
  } finally {
    cleanup(dir);
  }
});

test('blocked and paused missions remain resolvable by number', () => {
  const dir = makeWorkspace();
  try {
    appendMission(dir, { id: 'mission-blocked', n: 20, status: 'blocked' });
    appendMission(dir, { id: 'mission-paused', n: 21, status: 'paused' });

    for (const [number, id, status] of [[20, 'mission-blocked', 'blocked'], [21, 'mission-paused', 'paused']]) {
      const resolved = runCli(['mission', 'status', String(number), '--json'], dir);
      assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
      const mission = JSON.parse(resolved.stdout).missions[0];
      assert.equal(mission.id, id);
      assert.equal(mission.status, status);
    }
  } finally {
    cleanup(dir);
  }
});

test('duplicate mission numbers prefer a non-terminal mission and warn with both ids', () => {
  const dir = makeWorkspace();
  try {
    appendMission(dir, { id: 'mission-live', n: 30, status: 'paused' });
    appendMission(dir, { id: 'mission-newer', n: 30, status: 'planning', updated_at: '2026-07-10T11:00:00.000Z' });
    appendMission(dir, { id: 'mission-done', n: 30, status: 'complete', updated_at: '2026-07-10T12:00:00.000Z' });

    const listed = runCli(['mission', 'list', '--local'], dir);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /Mission: #30 mission newer/);
    assert.match(listed.stdout, /Mission: ion-live mission live/);
    assert.match(listed.stdout, /Mission: ion-done mission done/);
    assert.doesNotMatch(listed.stdout, /Mission: #30 mission (?:live|done)/);

    const resolved = runCli(['mission', 'status', '#30', '--json'], dir);
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(JSON.parse(resolved.stdout).missions[0].id, 'mission-newer');
    assert.match(resolved.stderr, /warning: mission number #30 is shared by mission-done, mission-newer, mission-live; using mission-newer\./);
  } finally {
    cleanup(dir);
  }
});

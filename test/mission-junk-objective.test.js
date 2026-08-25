const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listMissions, missionObjectiveIsJunk, selectDueMission } = require('../commands/mission');
const { withMissionFullJson } = require('./helpers/mission-json');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-junk-test-'));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], { cwd, encoding: 'utf8' });
}

function appendMission(dir, mission) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    schema: 'atris.mission.v1',
    owner: 'mission-lead',
    status: 'planning',
    runner: 'claude',
    cadence: '1m',
    verifier: 'node -e "process.exit(1)"',
    always_on: true,
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    task_ids: [],
    human_asks: [],
    ...mission,
  })}\n`, 'utf8');
}

test('mission creation rejects junk objectives before writing state', () => {
  for (const objective of ['--help', 'go go go']) {
    const dir = makeTempDir();
    try {
      const result = runCli(['mission', 'start', objective, '--owner', 'mission-lead', '--no-verify', '--json'], dir);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stdout, /mission start refused junk objective/);
      assert.match(result.stdout, new RegExp(objective.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(listMissions(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('mission junk gate allows creation with a concrete objective', () => {
  const dir = makeTempDir();
  try {
    const objective = 'ship the heartbeat junk-objective gate';
    assert.equal(missionObjectiveIsJunk(objective), false);
    const result = runCli(['mission', 'start', objective, '--owner', 'mission-lead', '--no-verify', '--json'], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).mission.objective, objective);
    assert.equal(listMissions(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('due selection auto-stops pre-existing junk and selects real work', () => {
  const dir = makeTempDir();
  try {
    appendMission(dir, { id: 'junk-mission', slug: 'junk-mission', objective: 'go go go' });
    appendMission(dir, { id: 'real-mission', slug: 'real-mission', objective: 'ship the heartbeat gate', updated_at: '2026-07-19T00:00:00.000Z' });

    const due = selectDueMission(dir, new Date('2026-07-23T00:00:00.000Z'));
    assert.equal(due.id, 'real-mission');
    const stopped = listMissions(dir).find((mission) => mission.id === 'junk-mission');
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.stop_reason, 'junk_objective_gate');
    assert.ok(stopped.stopped_at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

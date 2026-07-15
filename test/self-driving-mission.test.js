'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-self-driving-mission-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function startWithDestination(dir, objective, destination) {
  return runCli([
    'mission',
    'start',
    objective,
    '--owner',
    'mission-lead',
    '--destination',
    destination,
    '--no-verify',
    '--json',
  ], dir);
}

test('mission destination persists and round-trips through status JSON', () => {
  const dir = makeTempDir();
  try {
    const destination = 'Ship one verified self-driving mission slice';
    const started = startWithDestination(dir, 'Persist a mission trip contract', destination);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const startedPayload = JSON.parse(started.stdout);
    const drive = startedPayload.mission.drive;

    assert.equal(drive.schema, 'atris.mission.drive.v1');
    assert.equal(drive.destination, destination);
    assert.match(drive.destination_hash, /^[a-f0-9]{64}$/);
    assert.equal(drive.autonomy_level, 'L1');
    assert.equal(drive.route_version, 1);
    assert.equal(drive.position, 0);
    assert.deepEqual(drive.legs, []);
    assert.deepEqual(drive.hard_gates, []);
    assert.equal(drive.budget, null);
    assert.equal(drive.stop_reason, null);

    const status = runCli(['mission', 'status', startedPayload.mission.id, '--json'], dir);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.deepEqual(JSON.parse(status.stdout).missions[0].drive, drive);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a destination change is recorded as an operator-gated proposal', () => {
  const dir = makeTempDir();
  try {
    const objective = 'Keep one mission destination stable';
    const originalDestination = 'Arrive with verified mission state';
    const proposedDestination = 'Arrive with a fleet dashboard';
    const started = startWithDestination(dir, objective, originalDestination);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const original = JSON.parse(started.stdout).mission;

    const changed = startWithDestination(dir, objective, proposedDestination);
    assert.equal(changed.status, 0, changed.stderr || changed.stdout);
    const changedPayload = JSON.parse(changed.stdout);
    assert.equal(changedPayload.action, 'mission_destination_change_proposed');
    assert.equal(changedPayload.operator_gate_required, true);
    assert.equal(changedPayload.mission.id, original.id);
    assert.equal(changedPayload.mission.drive.destination, originalDestination);
    assert.equal(changedPayload.mission.drive.destination_hash, original.drive.destination_hash);
    assert.equal(changedPayload.proposal.destination, proposedDestination);
    assert.match(changedPayload.proposal.destination_hash, /^[a-f0-9]{64}$/);
    assert.equal(changedPayload.proposal.operator_gated, true);
    assert.match(changedPayload.proposal.reason, /operator approval/);

    const status = runCli(['mission', 'status', original.id, '--json'], dir);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const savedDrive = JSON.parse(status.stdout).missions[0].drive;
    assert.equal(savedDrive.destination, originalDestination);
    assert.deepEqual(savedDrive.pending_destination_proposal, changedPayload.proposal);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

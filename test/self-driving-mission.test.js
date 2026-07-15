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

function runCli(args, cwd, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    input: options.input,
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

function routeLeg(id, dependencies = []) {
  return {
    id,
    objective: `Complete ${id}`,
    dependencies,
    files: [`${id}.js`],
    verifier: `node --check ${id}.js`,
    stop_condition: `${id} verifier passes`,
  };
}

function setRoute(dir, missionId, proposal, extraArgs = []) {
  return runCli(
    ['mission', 'route', 'set', missionId, ...extraArgs, '--json'],
    dir,
    { input: JSON.stringify(proposal) },
  );
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

test('a valid linear route persists and bumps route version', () => {
  const dir = makeTempDir();
  try {
    const started = startWithDestination(dir, 'Compile one linear route', 'Land two verified route legs');
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const legs = [routeLeg('contract'), routeLeg('tests', ['contract'])];
    const routeFile = path.join(dir, 'route.json');
    fs.writeFileSync(routeFile, JSON.stringify({ legs, hard_gates: ['destination_change'] }));

    const result = runCli(['mission', 'route', 'set', mission.id, '--file', routeFile, '--json'], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, 'mission_route_set');
    assert.equal(payload.route_version, 2);
    assert.deepEqual(payload.legs, legs);
    assert.deepEqual(payload.hard_gates, ['destination_change']);

    const status = runCli(['mission', 'status', mission.id, '--json'], dir);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const drive = JSON.parse(status.stdout).missions[0].drive;
    assert.equal(drive.route_version, 2);
    assert.equal(drive.position, 0);
    assert.deepEqual(drive.legs, legs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('independent route legs are accepted from stdin', () => {
  const dir = makeTempDir();
  try {
    const started = startWithDestination(dir, 'Compile independent route legs', 'Verify two disjoint surfaces');
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const docsLeg = { ...routeLeg('docs'), surface: 'operator documentation' };
    delete docsLeg.files;
    const legs = [routeLeg('cli'), docsLeg];

    const result = setRoute(dir, mission.id, legs);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.mission.drive.legs, legs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dependency cycle is rejected and its reason is preserved', () => {
  const dir = makeTempDir();
  try {
    const started = startWithDestination(dir, 'Reject cyclic route legs', 'Keep route dependencies falsifiable');
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const legs = [routeLeg('first', ['second']), routeLeg('second', ['first'])];

    const result = setRoute(dir, mission.id, legs);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, 'mission_route_rejected');
    assert.equal(payload.reason_code, 'dependency_cycle');
    assert.match(payload.reason, /cycle/);
    assert.equal(payload.mission.drive.route_version, 1);
    assert.deepEqual(payload.mission.drive.legs, []);
    assert.deepEqual(payload.mission.drive.pending_route_proposal.legs, legs);
    assert.equal(payload.mission.drive.pending_route_proposal.reason_code, 'dependency_cycle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a route leg without a verifier is rejected and preserved', () => {
  const dir = makeTempDir();
  try {
    const started = startWithDestination(dir, 'Reject an unverifiable route', 'Require proof for every route leg');
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const leg = routeLeg('unverified');
    delete leg.verifier;

    const result = setRoute(dir, mission.id, [leg]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.reason_code, 'missing_verifier');
    assert.match(payload.reason, /missing a verifier/);
    assert.equal(payload.mission.drive.pending_route_proposal.reason, payload.reason);
    assert.deepEqual(payload.mission.drive.pending_route_proposal.legs, [leg]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported hard gates and missing scope reject without replacing the route', () => {
  const dir = makeTempDir();
  try {
    const started = startWithDestination(dir, 'Reject unsafe route shapes', 'Accept only bounded supported route legs');
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const unsupported = setRoute(dir, mission.id, { legs: [routeLeg('gate')], hard_gates: ['unbounded_authority'] });
    assert.equal(unsupported.status, 1, unsupported.stderr || unsupported.stdout);
    assert.equal(JSON.parse(unsupported.stdout).reason_code, 'unsupported_hard_gate');

    const broadLeg = routeLeg('broad');
    delete broadLeg.files;
    const broad = setRoute(dir, mission.id, [broadLeg]);
    assert.equal(broad.status, 1, broad.stderr || broad.stdout);
    const broadPayload = JSON.parse(broad.stdout);
    assert.equal(broadPayload.reason_code, 'missing_scope');
    assert.equal(broadPayload.mission.drive.route_version, 1);
    assert.deepEqual(broadPayload.mission.drive.legs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-verifier-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('mission start rejects static numeric verifier from expanded shell substitution', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli([
      'mission',
      'start',
      'bad expanded verifier',
      '--owner',
      'mission-lead',
      '--verify',
      'test      476 -ge 478',
      '--json',
    ], { cwd: dir });

    assert.equal(res.status, 2);
    assert.equal(res.stderr, '');
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Invalid --verify/);
    assert.match(payload.error, /shell substitution expanded/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);

    const human = runCli([
      'mission',
      'start',
      'bad expanded verifier',
      '--owner',
      'mission-lead',
      '--verify',
      'test 476 -ge 478',
    ], { cwd: dir });
    assert.equal(human.status, 2);
    assert.equal(human.stdout, '');
    assert.match(human.stderr, /Invalid --verify/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start preserves dynamic verifier when quoted by caller', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const verifier = 'test $(wc -l < atris/learnings.jsonl) -ge 478';
    const res = runCli([
      'mission',
      'start',
      'dynamic verifier',
      '--owner',
      'mission-lead',
      '--verify',
      verifier,
      '--json',
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.verifier, verifier);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start warns when no verifier is attached', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    // Create the owner member so the unrelated missing_owner_member warning
    // does not fire; this test is about the missing_verifier warning only.
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'mission-lead'), { recursive: true });
    const res = runCli([
      'mission',
      'start',
      'unverified mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.verifier, '');
    assert.equal(payload.warnings.length, 1);
    assert.equal(payload.warnings[0].code, 'missing_verifier');
    assert.match(payload.warnings[0].message, /cannot complete automatically/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission doctor stops flagging a drive-parked no-verifier mission (parking sticks)', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const started = runCli([
      'mission', 'start', 'parked zombie', '--owner', 'mission-lead', '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const missionId = JSON.parse(started.stdout).mission.id;

    const flaggedBefore = JSON.parse(
      runCli(['mission', 'doctor', '--local', '--json'], { cwd: dir }).stdout,
    ).findings.filter((f) => f.code === 'missing_verifier').map((f) => f.mission_id);
    assert.ok(flaggedBefore.includes(missionId), 'active no-verifier mission should be flagged');

    const paused = runCli([
      'mission', 'stop', missionId, '--pause', '--reason', 'drive: no verifier + stale, auto-parked (restart with a --verify to resume)',
    ], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);

    const flaggedAfter = JSON.parse(
      runCli(['mission', 'doctor', '--local', '--json'], { cwd: dir }).stdout,
    ).findings.filter((f) => f.code === 'missing_verifier').map((f) => f.mission_id);
    assert.ok(
      !flaggedAfter.includes(missionId),
      'drive-parked mission is settled and must not be re-flagged as missing_verifier',
    );
  } finally {
    cleanupTempDir(dir);
  }
});

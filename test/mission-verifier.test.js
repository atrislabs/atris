const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const {
  buildEngineVerifyPrompt,
  engineVerifierResultFromRun,
  missionVerifierCheckedText,
} = require('../commands/mission');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-verifier-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('engine verify contract requires real execution and parses only the final verdict line', () => {
  const prompt = buildEngineVerifyPrompt({ objective: 'prove the changed surface' }, 3);
  assert.match(prompt, /ACTUALLY RUN the changed surface on this computer/);
  assert.match(prompt, /real commands and real exit codes/);
  assert.match(prompt, /Do not edit files/);
  assert.equal(engineVerifierResultFromRun({ ok: true, result: 'npm test\nexit 0\nVERDICT: PASS' }).passed, true);
  assert.equal(engineVerifierResultFromRun({ ok: true, result: 'VERDICT: PASS\nextra text' }).passed, false);
  assert.deepEqual(
    engineVerifierResultFromRun({ ok: false, timedOut: true, stderr: 'timed out' }),
    { passed: false, mode: 'engine-unavailable', engine: 'codex', timed_out: true, output: 'timed out' },
  );
});

test('unverified and failed tick recap text carries a visible warning marker', () => {
  assert.match(missionVerifierCheckedText(null, {}), /^UNVERIFIED:/);
  assert.match(missionVerifierCheckedText({ passed: false, command: 'false' }, {}), /^VERIFY FAILED:/);
  assert.match(missionVerifierCheckedText({ passed: false, mode: 'engine-unavailable' }, {}), /^VERIFY FAILED:/);
});

test('mission run uses the repo default verifier and explicit no-verify stays unverified', () => {
  const dir = makeTempDir();
  const runnerEnv = {
    ATRIS_RUNNER_BIN: process.execPath,
    ATRIS_RUNNER_COMMAND_TEMPLATE: `${process.execPath} -e "process.stdout.write('tick receipt\\nlayer: capabilities\\nVERDICT: PASS\\n')"`,
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'mission-lead'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'MEMBER.md'), '# Mission Lead\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const started = runCli([
      'mission', 'start', 'engine verify fallback', '--owner', 'mission-lead',
      '--runner', 'codex', '--no-verify', '--json',
    ], { cwd: dir });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;

    const verified = runCli([
      'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--json',
    ], { cwd: dir, env: runnerEnv });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    const verifiedPayload = JSON.parse(verified.stdout);
    assert.equal(verifiedPayload.ticks[0].verifier_passed, true);
    assert.equal(verifiedPayload.mission.verifier_result.command, 'npm test');
    assert.equal(verifiedPayload.mission.verifier_result.status, 0);

    const skippedStarted = runCli([
      'mission', 'start', 'explicit verify skip', '--owner', 'mission-lead',
      '--runner', 'codex', '--no-verify', '--json',
    ], { cwd: dir });
    assert.equal(skippedStarted.status, 0, skippedStarted.stderr || skippedStarted.stdout);
    const skippedMission = JSON.parse(skippedStarted.stdout).mission;
    const skipped = runCli([
      'mission', 'run', skippedMission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json',
    ], { cwd: dir, env: runnerEnv });
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    const skippedPayload = JSON.parse(skipped.stdout);
    assert.equal(skippedPayload.ticks[0].verifier_passed, undefined);
    const tickReceipt = JSON.parse(fs.readFileSync(path.join(dir, skippedPayload.mission.receipt_path), 'utf8'));
    assert.match(tickReceipt.result.landing.checked, /^UNVERIFIED:/);
  } finally {
    cleanupTempDir(dir);
  }
});

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

test('mission start refuses when no verifier is attached', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli([
      'mission',
      'start',
      'unverified mission',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });

    assert.equal(res.status, 2);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /no verifier/);
    assert.match(payload.error, /--no-verify/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start with --no-verify creates the mission but still warns', () => {
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
      '--no-verify',
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
      'mission', 'start', 'parked zombie', '--owner', 'mission-lead', '--no-verify', '--json',
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

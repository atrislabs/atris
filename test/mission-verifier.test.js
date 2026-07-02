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

test('always-on mission start without a verifier is blocked unless --no-verify opts out', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const blocked = runCli([
      'mission',
      'start',
      'unverified mission',
      '--owner',
      'mission-lead',
      '--always-on',
      '--json',
    ], { cwd: dir });

    assert.equal(blocked.status, 2);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.ok, false);
    assert.match(blockedPayload.error, /need a verifier/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);

    const res = runCli([
      'mission',
      'start',
      'unverified mission',
      '--owner',
      'mission-lead',
      '--always-on',
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

test('mission start --help never creates a mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['mission', 'start', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /atris mission start/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission dedupe dry-runs and stops duplicate active missions', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const first = runCli([
      'mission',
      'start',
      'same cleanup target',
      '--owner',
      'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const second = runCli([
      'mission',
      'start',
      'same cleanup target',
      '--owner',
      'mission-lead',
      '--duplicate',
      '--json',
    ], { cwd: dir });
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const dry = runCli(['mission', 'dedupe', '--json'], { cwd: dir });
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    const dryPayload = JSON.parse(dry.stdout);
    assert.equal(dryPayload.action, 'mission_dedupe_dry_run');
    assert.equal(dryPayload.targets.length, 1);
    assert.match(dryPayload.targets[0].reason, /duplicate of/);

    const applied = runCli(['mission', 'dedupe', '--apply', '--json'], { cwd: dir });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.equal(appliedPayload.action, 'mission_dedupe');
    assert.deepEqual(appliedPayload.stopped, [dryPayload.targets[0].id]);

    const status = runCli(['mission', 'status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    const stopped = statusPayload.missions.find((mission) => mission.id === dryPayload.targets[0].id);
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.stop_reason, /mission dedupe: duplicate of/);
  } finally {
    cleanupTempDir(dir);
  }
});

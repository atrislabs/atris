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
    assert.match(res.stderr, /Invalid --verify/);
    assert.match(res.stderr, /shell substitution expanded/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
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

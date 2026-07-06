const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-worktree-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initGitRepo(dir) {
  runGit(['init'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test User'], dir);
}

function commitAll(dir, message) {
  runGit(['add', '.'], dir);
  runGit(['commit', '-m', message], dir);
}

function startMission(dir, title, extraArgs = []) {
  const res = runCli(['mission', 'start', '--no-verify', title, '--owner', 'mission-lead', '--json', ...extraArgs], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

function readReceipt(dir, relPath) {
  return JSON.parse(fs.readFileSync(path.join(dir, relPath), 'utf8'));
}

test('mission tick receipt surfaces dirty worktree when no verifier exists', () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const mission = startMission(dir, 'dirty no verifier mission');
    commitAll(dir, 'baseline');

    fs.writeFileSync(path.join(dir, 'outside.txt'), 'dirty\n');
    const tick = runCli(['mission', 'tick', mission.id, '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const payload = JSON.parse(tick.stdout);
    const receipt = readReceipt(dir, payload.receipt_path);

    assert.equal(payload.tick.worktree.available, true);
    assert.equal(payload.tick.worktree.unverified_dirty, true);
    assert(payload.tick.worktree.after_dirty_count > 0);
    assert(payload.tick.worktree.dirty_sample_after.some((entry) => entry.includes('outside.txt')));
    assert.equal(receipt.result.worktree.unverified_dirty, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run receipt records verifier worktree deltas', () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const verifier = `${process.execPath} -e "require('fs').writeFileSync('verifier-output.txt','ok\\\\n')"`;
    const mission = startMission(dir, 'verifier writes proof file', ['--verify', verifier]);
    commitAll(dir, 'baseline');

    const run = runCli(['mission', 'run', mission.id, '--no-claude', '--max-ticks', '1', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    const tickWorktree = payload.ticks[0].worktree;
    const receipt = readReceipt(dir, payload.mission.receipt_path);

    assert.equal(payload.mission.status, 'ready');
    assert.equal(tickWorktree.available, true);
    assert.equal(tickWorktree.changed, true);
    assert.equal(tickWorktree.unverified_change, false);
    assert(tickWorktree.new_dirty_sample.some((entry) => entry.includes('verifier-output.txt')));
    assert.equal(receipt.result.worktree.changed, true);
  } finally {
    cleanupTempDir(dir);
  }
});

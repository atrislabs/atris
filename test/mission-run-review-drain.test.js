const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-run-review-drain-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
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

function initWorkspace(repo) {
  runGit(['init'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test User'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'committed\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'clean baseline'], repo);
}

function seedReviewLane(dir) {
  // A green receipt + a readied task gives the drain something real to act on.
  const receiptRel = 'atris/runs/proof.json';
  fs.mkdirSync(path.join(dir, 'atris/runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, receiptRel), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    result: { passed: true },
  }) + '\n', 'utf8');
  const created = runCli(['task', 'new', 'drain seed task', '--tag', 'probe'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const ref = created.stdout.trim().split('\t')[0];
  runCli(['task', 'claim', ref, '--as', 'seed-agent'], { cwd: dir });
  const ready = runCli(['task', 'ready', ref, '--proof', 'suite green; run_id=123456789; receipt ' + receiptRel], { cwd: dir });
  assert.equal(ready.status, 0, ready.stderr || ready.stdout);
  return ref;
}

function startMission(dir, objective, extra = []) {
  const res = runCli(['mission', 'start', '--no-verify', objective, '--owner', 'mission-lead', ...extra, '--json'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

test('always-on mission run ticks drain the review lane and record the receipt', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    seedReviewLane(dir);
    const mission = startMission(dir, 'always-on drain mission', ['--always-on']);

    const run = runCli(['mission', 'run', mission.id, '--no-claude', '--max-ticks', '1', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    const drain = payload.ticks[0].review_lane;

    assert.ok(drain, 'always-on tick must carry a review_lane block');
    assert.equal(drain.ok, true, JSON.stringify(drain).slice(0, 300));
    assert.ok(drain.total_acted_count >= 1, 'drain must act on the seeded review task');
    assert.ok(drain.receipt_path, 'drain must point at its receipt');
    assert.ok(
      fs.existsSync(path.join(dir, '.atris', 'state', 'review-lane-run.latest.json')),
      'review-lane-run receipt must exist on disk',
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('non-always-on mission run ticks do not drain the review lane', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    seedReviewLane(dir);
    const mission = startMission(dir, 'plain mission');

    const run = runCli(['mission', 'run', mission.id, '--no-claude', '--max-ticks', '1', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ticks[0].review_lane ?? null, null, 'plain missions must not auto-drain');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run --no-drain skips the review lane on always-on missions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    seedReviewLane(dir);
    const mission = startMission(dir, 'always-on no-drain mission', ['--always-on']);

    const run = runCli(['mission', 'run', mission.id, '--no-claude', '--max-ticks', '1', '--no-drain', '--json'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    const drain = payload.ticks[0].review_lane;
    assert.ok(drain && drain.skipped === true, 'no-drain must record an explicit skip');
  } finally {
    cleanupTempDir(dir);
  }
});

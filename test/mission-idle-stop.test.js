const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { tickMadeProgress, consecutiveNoProgressTicks } = require('../commands/mission');

// BCK-1324: a mission run loop that keeps ticking after there is nothing left
// to do burns the whole tick budget on "holding" ticks — live evidence is the
// 2026-07-11 run of mission-2026-07-10-revenue-bounded-customer-mis-e7b93c4d,
// which sat at worktree.new_since_baseline_count=4 for 15 consecutive ticks,
// every one self-reporting status=ran/reason=tick-ok. `atris mission run`
// must now stop itself honestly (status=stopped, receipt written) after N
// consecutive ticks that leave no structural trace, instead of grinding to
// max-ticks or max-wall on manufactured busywork.

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idle-stop-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env, timeout: 30000 });
}

function startMission(repo, objective, owner, extraArgs = []) {
  const res = runCli(['mission', 'start', '--no-verify', objective, '--owner', owner, '--json', ...extraArgs], repo);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(res.stdout).mission;
}

// ---------------------------------------------------------------------------
// Unit coverage on the structural no-progress signal itself: the worktree
// diff and verifier result are ground truth, not the claude summary text —
// a tick that self-labels "holding tick, no drift" and a tick that never
// says anything about progress must be treated identically if their
// worktree/verifier shape is identical.
// ---------------------------------------------------------------------------

test('tickMadeProgress: no new/cleared dirty files and no verifier pass is not progress', () => {
  const idleTick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(idleTick), false);
});

test('tickMadeProgress: a new dirty file counts as progress even if verifier did not run', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: a cleared dirty file (e.g. a commit landed) counts as progress', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 3 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: verifier newly passing counts as progress even with a flat worktree', () => {
  const tick = {
    status: 'ran',
    reason: 'tick-ok',
    verifier_passed: true,
    worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 },
  };
  assert.equal(tickMadeProgress(tick), true);
});

test('tickMadeProgress: an errored or skipped tick is never counted as idle (other breakers own those)', () => {
  assert.equal(tickMadeProgress({ status: 'errored', reason: 'claude-timeout' }), true);
  assert.equal(tickMadeProgress({ status: 'skipped', reason: 'quiet-hours' }), true);
});

test('consecutiveNoProgressTicks: only counts the trailing idle streak, resets on any progressing tick', () => {
  const ticks = [
    { status: 'ran', worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 } }, // progress
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 1
    { status: 'ran', worktree: { available: true, new_dirty_count: 1, cleared_dirty_count: 0 } }, // progress -> resets
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 1
    { status: 'ran', worktree: { available: true, new_dirty_count: 0, cleared_dirty_count: 0 } }, // idle 2
  ];
  assert.equal(consecutiveNoProgressTicks(ticks), 2);
});

// ---------------------------------------------------------------------------
// End-to-end: drive the real `atris mission run` loop with --no-claude, which
// never touches the worktree, so every tick is structurally idle by
// construction. This is the same shape as the live incident's tail — status
// ran/reason tick-ok, flat worktree, repeated N times.
// ---------------------------------------------------------------------------

test('mission run stops honestly at the idle-tick threshold instead of burning the full tick budget', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop threshold test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '10', '--max-idle-ticks', '3', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.pause_reason, 'no-progress');
    assert.equal(payload.mission.status, 'stopped', 'a no-progress stop must be a clean stop, not a resumable pause');
    assert.match(payload.mission.stop_reason, /no-progress/);
    // Stopped at the idle threshold, well short of the 10-tick budget.
    assert.equal(payload.tick_count, 3);
    assert.ok(payload.mission.receipt_path, 'a no-progress stop must still write a receipt like other stop paths');
    assert.ok(fs.existsSync(path.join(repo, payload.mission.receipt_path)), 'the receipt file must actually exist on disk');

    // A self-drive run must treat no-progress as a clean stop, never a
    // dispatchable blocker — handleMissionBlocker must not fire for it.
    assert.equal(payload.blocker, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--max-idle-ticks 0 disables the guard and runs out the full tick budget', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop disabled test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '5', '--max-idle-ticks', '0', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.ok, true);
    assert.notEqual(payload.pause_reason, 'no-progress');
    assert.equal(payload.tick_count, 5, 'with the guard disabled, all 5 idle ticks must run');
    assert.notEqual(payload.mission.status, 'stopped');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--due (self-drive) mode stops on no-progress without filing or dispatching a blocker task', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop self-drive test', 'alice');
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--due', '--max-ticks', '10', '--max-idle-ticks', '2', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.pause_reason, 'no-progress');
    assert.equal(payload.mission.status, 'stopped');
    assert.equal(payload.blocker, null, 'no-progress must never route through handleMissionBlocker');

    // No mission-blocker task should have been filed for this mission.
    const tasksList = runCli(['task', 'list', '--json'], repo);
    if (tasksList.status === 0) {
      const tasks = JSON.parse(tasksList.stdout).tasks || [];
      const blockerTasks = tasks.filter((t) => t.metadata?.mission_id === mission.id);
      assert.equal(blockerTasks.length, 0);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a single progressing tick resets the idle counter (default threshold of 3 needs 3 in a row)', () => {
  const { base, repo } = makeRepo();
  try {
    const mission = startMission(repo, 'idle stop reset test', 'alice');
    // Two idle ticks, short of the default max-idle-ticks (3) threshold —
    // the run must NOT stop early.
    const res = runCli(
      ['mission', 'run', mission.id, '--no-claude', '--no-verify', '--max-ticks', '2', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.tick_count, 2);
    assert.notEqual(payload.pause_reason, 'no-progress', 'two idle ticks must not trip the default 3-tick threshold');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

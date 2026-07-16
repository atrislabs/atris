const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Footgun (d), tick-path half. `mission run` re-opens the spend-full-budget
// window by stamping resumed_at BEFORE it reads the budget, so a mission resumed
// after its original window elapsed keeps working. The standalone `mission tick`
// path never resumed a paused mission, so it read a stale (absent) resumed_at and
// could land the mission on the first tick. This proves `mission tick` now stamps
// resumed_at when it resumes a paused mission — the anchor the budget clock reads
// (see mission-budget-resume-anchor.test.js for the clock math it feeds).

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const PASSING_VERIFIER = `${process.execPath} -e "process.exit(0)"`;

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function initWorkspace(dir) {
  runGit(['init'], dir);
  runGit(['config', 'user.email', 'test@example.com'], dir);
  runGit(['config', 'user.name', 'Test User'], dir);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'committed\n');
  runGit(['add', '.'], dir);
  runGit(['commit', '-m', 'clean baseline'], dir);
}

test('mission tick re-opens the budget window when it resumes a paused mission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-tick-resume-'));
  try {
    initWorkspace(dir);

    const startRes = runCli(
      ['mission', 'start', '--no-verify', 'resume via tick', '--owner', 'mission-lead',
        '--spend-full-budget', '--budget', 'quick', '--json'],
      dir,
    );
    assert.equal(startRes.status, 0, startRes.stderr || startRes.stdout);
    const started = JSON.parse(startRes.stdout).mission;
    assert.equal(started.budget_contract?.policy, 'spend_full_budget', 'mission should be spend-full-budget');
    // Fresh start: no resume has happened yet.
    assert.ok(!started.resumed_at, 'no resumed_at before any pause/resume');

    const pauseRes = runCli(['mission', 'pause', started.id, '--reason', 'test pause', '--json'], dir);
    assert.equal(pauseRes.status, 0, pauseRes.stderr || pauseRes.stdout);
    const paused = JSON.parse(pauseRes.stdout).mission;
    assert.equal(paused.status, 'paused');
    assert.ok(!paused.resumed_at, 'pause does not stamp resumed_at');

    const tickRes = runCli(
      ['mission', 'tick', started.id, '--summary', 'resumed and shipped', '--json'],
      dir,
    );
    assert.equal(tickRes.status, 0, tickRes.stderr || tickRes.stdout);
    const ticked = JSON.parse(tickRes.stdout).mission;

    // The fix: the tick resumed the paused mission and stamped a fresh anchor, so
    // the spend-full-budget clock now measures from now, not from the elapsed
    // original window. Before the fix this stayed null and the budget could read
    // zero on the first tick after a resume.
    assert.equal(ticked.status, 'running', 'resumed mission keeps running, not landed');
    assert.ok(ticked.resumed_at, 'tick stamps resumed_at when it resumes a paused mission');
    assert.ok(
      Date.parse(ticked.resumed_at) >= Date.parse(started.started_at || started.created_at),
      'resumed_at is anchored at (or after) the original start',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

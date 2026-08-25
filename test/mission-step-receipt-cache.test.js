const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findCachedMissionStepReceipt } = require('../lib/receipt-evidence');

// Resume after interrupt: a completed tick receipt already on disk for the next
// tick_index must be reused. Without the cache, mission tick re-derives that
// step and writes a second receipt.

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
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

function writeCompletedTickReceipt(dir, missionId, tickIndex, { verifierPassed = true } = {}) {
  const runsDir = path.join(dir, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const name = `mission-${missionId}-cached-tick-${tickIndex}.json`;
  const rel = path.join('atris', 'runs', name);
  const receipt = {
    schema: 'atris.mission_receipt.v1',
    mission_id: missionId,
    at: '2026-08-10T12:00:00.000Z',
    result: {
      kind: 'mission_tick',
      passed: verifierPassed,
      tick: {
        status: 'ran',
        reason: 'tick-recorded',
        tick_index: tickIndex,
        ran: true,
        started_at: '2026-08-10T12:00:00.000Z',
        finished_at: '2026-08-10T12:00:01.000Z',
        summary: 'already finished before interrupt',
        verifier_passed: verifierPassed,
        layer: 'code',
        layer_source: 'receipt',
      },
      verifier_result: {
        command: `${process.execPath} -e "process.exit(0)"`,
        passed: verifierPassed,
        status: 0,
      },
    },
  };
  fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return rel;
}

test('findCachedMissionStepReceipt returns the completed receipt for a tick', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-step-cache-helper-'));
  try {
    const missionId = 'mission-2026-08-10-cache-demo';
    const rel = writeCompletedTickReceipt(dir, missionId, 1);
    const hit = findCachedMissionStepReceipt(dir, { missionId, tickIndex: 1 });
    assert.ok(hit, 'cache finds the completed tick receipt');
    assert.equal(hit.receipt_path, rel);
    assert.equal(hit.tick.tick_index, 1);
    assert.equal(hit.tick.status, 'ran');
    assert.equal(hit.verifier_result.passed, true);
    assert.equal(
      findCachedMissionStepReceipt(dir, { missionId, tickIndex: 2 }),
      null,
      'missing tick index is a miss',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission tick resume skips a step that already has a receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-step-cache-tick-'));
  try {
    initWorkspace(dir);

    const startRes = runCli(
      ['mission', 'start', '--no-verify', 'receipt cached resume step', '--owner', 'builder', '--json'],
      dir,
    );
    assert.equal(startRes.status, 0, startRes.stderr || startRes.stdout);
    const mission = JSON.parse(startRes.stdout).mission;
    assert.equal(Number(mission.last_tick_index || 0), 0);

    // Simulate interrupt: receipt for tick 1 exists, mission index never advanced.
    const existingReceipt = writeCompletedTickReceipt(dir, mission.id, 1);
    const before = fs.readdirSync(path.join(dir, 'atris', 'runs'))
      .filter((name) => name.startsWith('mission-') && name.endsWith('.json'));

    const tickRes = runCli(
      ['mission', 'tick', mission.id, '--summary', 'should not re-run', '--json'],
      dir,
    );
    assert.equal(tickRes.status, 0, tickRes.stderr || tickRes.stdout);
    const payload = JSON.parse(tickRes.stdout);

    assert.equal(payload.cached, true, 'resume reports a cache hit');
    assert.equal(payload.tick.reason, 'receipt-cache-hit');
    assert.equal(payload.tick.cached, true);
    assert.equal(payload.receipt_path, existingReceipt);
    assert.equal(payload.mission.last_tick_index, 1, 'mission advances from the cached receipt');
    assert.match(String(payload.tick.summary || ''), /already finished before interrupt/);

    const after = fs.readdirSync(path.join(dir, 'atris', 'runs'))
      .filter((name) => name.startsWith('mission-') && name.endsWith('.json'));
    assert.equal(after.length, before.length, 'resume does not write a second receipt for the same step');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

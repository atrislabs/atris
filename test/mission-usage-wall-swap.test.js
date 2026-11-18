const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-wall-swap-'));
}

function writeBin(binDir, name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function runCli(args, cwd, env = {}, timeout = 90000) {
  const result = spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env },
  });
  if (result.error) throw result.error;
  return result;
}

// Regression (CLI-1166): a mission worker on the auto runner used to stall when
// its engine hit a usage wall. The walled engine's rate-limit cooldown is a
// run-global (`lastRateLimit`) value, so even after the auto runner marked that
// engine credit_out and resolved the NEXT tick to a different ready engine, the
// stale cooldown still fired — the loop either slept it out or paused for a human
// with `rate-limit-exceeded-wall`, despite a fresh engine being free to work.
// The fix clears the cooldown when the tick swaps to a different engine, so the
// run keeps working. claude runs first (it is the only path that parses the
// rate_limit_event that sets the cooldown); it walls out; the loop must swap to
// cursor and land a real second tick.
test('mission run swaps engines and keeps working after a usage wall instead of pausing', () => {
  const dir = makeWorkspace();
  try {
    const binDir = path.join(dir, 'bin');
    // claude (direct spawn path) emits a rate-limit cooldown event AND a
    // usage-limit result, so tick 1 both sets `lastRateLimit` and marks claude
    // credit_out. is_error makes the tick errored without an exit-code change.
    writeBin(
      binDir,
      'claude',
      [
        `printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":9999999999}}\\n'`,
        `printf '{"type":"result","result":"Usage limit reached. Purchase more credits.","is_error":true,"num_turns":1}\\n'`,
        'exit 0',
      ].join('\n'),
    );
    // cursor is the fallback executor the auto runner should swap to.
    writeBin(
      binDir,
      'cursor-agent',
      [
        'if [ "$1" = "--help" ]; then echo "-p --trust"; exit 0; fi',
        'echo "cursor completed the tick"',
        'echo "layer: capabilities"',
        'exit 0',
      ].join('\n'),
    );
    const pathValue = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const env = { PATH: pathValue };

    const started = runCli([
      'mission', 'start', 'usage wall swap mission', '--owner', 'mission-lead',
      '--runner', 'auto', '--no-verify', '--json',
    ], dir, env);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    assert.equal(mission.runner, 'auto');

    const run = runCli([
      'mission', 'run', mission.id, '--max-ticks', '2', '--max-wall', '60', '--no-verify', '--json',
    ], dir, env);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);

    // Tick 1: claude walls out and is marked credit_out.
    assert.equal(payload.ticks.length, 2, `expected a second tick after the swap, got ${payload.ticks.length}`);
    assert.equal(payload.ticks[0].engine_id, 'claude');
    assert.equal(payload.ticks[0].status, 'errored');
    assert.equal(payload.ticks[0].engine_health.status, 'credit_out');

    // Tick 2: the loop swapped to cursor and kept working instead of pausing.
    assert.equal(payload.ticks[1].engine_id, 'cursor');
    assert.equal(payload.ticks[1].status, 'ran');
    assert.equal(payload.ticks[1].engine_swapped_from, 'claude');

    // The run must not have paused for a human on the stale cooldown.
    assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

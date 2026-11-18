const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');

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

function usageWallMission(t, { fallback = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-usage-wall-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin');
  // Claude supplies the rate-limit metadata and is marked credit_out.
  writeBin(binDir, 'claude', [
    `printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":9999999999}}\\n'`,
    `printf '{"type":"result","result":"Usage limit reached. Purchase more credits.","is_error":true,"num_turns":1}\\n'`,
    'exit 0',
  ].join('\n'));
  if (fallback) {
    writeBin(binDir, 'cursor-agent', [
      'if [ "$1" = "--help" ]; then echo "-p --trust"; exit 0; fi',
      'echo "cursor completed the tick"',
      'echo "layer: capabilities"',
      'exit 0',
    ].join('\n'));
  }
  const env = { HOME: dir, PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  if (!fallback) {
    // Fable also uses the Claude binary, so make that profile unavailable.
    const changed = runCli(['engine', 'health', 'fable', '--set', 'credit_out', '--json'], dir, env);
    assert.equal(changed.status, 0, changed.stderr || changed.stdout);
  }
  const started = runCli([
    'mission', 'start', 'usage wall swap mission', '--owner', 'mission-lead',
    '--runner', 'auto', '--no-verify', '--json',
  ], dir, env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  assert.equal(mission.runner, 'auto');
  return { dir, env, mission };
}

function runUsageWall(t, { fallback, wall, cadence = 'manual' }) {
  const { dir, env, mission } = usageWallMission(t, { fallback });
  const run = runCli([
    'mission', 'run', mission.id, '--max-ticks', '2', '--max-wall', String(wall),
    '--cadence', cadence, '--no-verify', '--json',
  ], dir, env);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.ticks[0].engine_id, 'claude');
  assert.equal(payload.ticks[0].status, 'errored');
  assert.equal(payload.ticks[0].engine_health.status, 'credit_out');
  return payload;
}

test('mission run swaps engines and keeps working before the 30s error backoff', (t) => {
  const payload = runUsageWall(t, { wall: 15 });
  assert.equal(payload.ticks.length, 2);
  assert.equal(payload.ticks[1].engine_id, 'cursor');
  assert.equal(payload.ticks[1].status, 'ran');
  assert.equal(payload.ticks[1].engine_swapped_from, 'claude');
  assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
});

test('mission run still backs off if a usage wall leaves no ready engine', (t) => {
  const payload = runUsageWall(t, { fallback: false, wall: 3 });
  assert.equal(payload.ticks.length, 1, JSON.stringify(payload.ticks.map(tick => tick.engine_id)));
  assert.equal(payload.pause_reason, 'max-wall-reached');
});

test('mission run honors its cadence when switching to a ready engine', (t) => {
  const payload = runUsageWall(t, { wall: 15, cadence: '1s' });
  assert.equal(payload.ticks.length, 2);
  const [blocked, recovery] = payload.ticks;
  assert.equal(recovery.engine_id, 'cursor');
  assert.equal(recovery.status, 'ran');
  assert.ok(Date.parse(recovery.started_at) - Date.parse(blocked.finished_at) >= 1000);
});

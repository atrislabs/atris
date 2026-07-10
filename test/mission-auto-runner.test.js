const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const {
  resolveMissionRunnerSelection,
  resolveMissionTickRunner,
  recordMissionEngineTickOutcome,
} = require('../commands/mission');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-auto-'));
}

function writeBin(binDir, name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function executorPath(dir, codexBody = 'echo codex tick', cursorBody = 'echo cursor tick') {
  const binDir = path.join(dir, 'bin');
  writeBin(binDir, 'codex', codexBody);
  writeBin(binDir, 'cursor-agent', cursorBody);
  return `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
}

function withPath(nextPath, fn) {
  const previous = process.env.PATH;
  process.env.PATH = nextPath;
  try {
    return fn();
  } finally {
    process.env.PATH = previous;
  }
}

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env },
  });
}

test('auto resolves the highest-priority ready executor while native runners remain native', { concurrency: false }, () => {
  const dir = makeWorkspace();
  try {
    const pathValue = executorPath(dir);
    withPath(pathValue, () => {
      const resolved = resolveMissionTickRunner({ runner: 'auto' }, dir);
      assert.equal(resolved.engine_id, 'codex');
      assert.equal(resolved.mission.runner, 'codex');
    });

    assert.deepEqual(resolveMissionRunnerSelection('auto'), {
      requested: 'auto', runner: 'auto', engine: null, kind: 'auto',
    });
    for (const runner of ['manual', 'claude', 'atris2', 'codex_goal', 'drill']) {
      const selection = resolveMissionRunnerSelection(runner);
      assert.equal(selection.runner, runner);
      assert.equal(selection.kind, 'runner');
      assert.equal(resolveMissionTickRunner({ runner }, dir).mission.runner, runner);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto honors a ready preference and records why an unavailable preference fell back', { concurrency: false }, () => {
  const dir = makeWorkspace();
  try {
    const pathValue = executorPath(dir);
    withPath(pathValue, () => {
      const preferred = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'cursor' }, dir);
      assert.equal(preferred.engine_id, 'cursor');
      assert.equal(preferred.engine_fallback_reason, null);

      recordMissionEngineTickOutcome('cursor', {
        status: 'errored',
        reason: 'claude-error',
        claude: { stderr: 'Usage limit reached. Purchase more credits.' },
      }, dir);
      const fallback = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'cursor' }, dir);
      assert.equal(fallback.engine_id, 'codex');
      assert.equal(fallback.requested_engine, 'cursor');
      assert.match(fallback.engine_fallback_reason, /cursor is not ready \(credit_out\); fell back to codex/);

      recordMissionEngineTickOutcome('cursor', { status: 'ran', reason: 'tick-ok' }, dir);
      const recovered = resolveMissionTickRunner({ runner: 'auto', preferred_engine: 'cursor' }, dir);
      assert.equal(recovered.engine_id, 'cursor');
      assert.equal(recovered.engine_fallback_reason, null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed auto tick records health and the next tick skips that engine', () => {
  const dir = makeWorkspace();
  try {
    const pathValue = executorPath(
      dir,
      'echo "Usage limit reached. Purchase more credits." >&2\nexit 1',
      'echo "cursor completed the tick"',
    );
    const started = runCli([
      'mission', 'start', 'auto engine health mission', '--owner', 'mission-lead',
      '--runner', 'auto', '--no-verify', '--json',
    ], dir, { PATH: pathValue });
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    assert.equal(mission.runner, 'auto');

    const changed = runCli(['mission', 'set-runner', mission.id, 'auto', '--json'], dir, { PATH: pathValue });
    assert.equal(changed.status, 0, changed.stderr || changed.stdout);
    assert.equal(JSON.parse(changed.stdout).mission.runner_kind, 'auto');

    const firstRun = runCli([
      'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json',
    ], dir, { PATH: pathValue });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.ticks[0].engine_id, 'codex');
    assert.equal(firstPayload.ticks[0].status, 'errored');
    assert.equal(firstPayload.ticks[0].engine_health.status, 'credit_out');

    const secondRun = runCli([
      'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json',
    ], dir, { PATH: pathValue });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const secondPayload = JSON.parse(secondRun.stdout);
    assert.equal(secondPayload.ticks[0].engine_id, 'cursor');
    assert.equal(secondPayload.ticks[0].status, 'ran');
    assert.equal(secondPayload.ticks[0].engine_health.status, 'ready');

    const firstReceipt = JSON.parse(fs.readFileSync(path.join(dir, firstPayload.summary_receipt), 'utf8'));
    const secondReceipt = JSON.parse(fs.readFileSync(path.join(dir, secondPayload.summary_receipt), 'utf8'));
    assert.equal(firstReceipt.result.ticks[0].engine_id, 'codex');
    assert.equal(secondReceipt.result.ticks[0].engine_id, 'cursor');
    const registry = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'engines.json'), 'utf8'));
    assert.equal(registry.engines.find((engine) => engine.id === 'codex').health.status, 'credit_out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

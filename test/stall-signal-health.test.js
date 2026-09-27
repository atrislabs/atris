'use strict';

// Engine health reads only engine-level signals. A run's own output (report,
// stdout, the claude summary and receipt) is the work it produced, never the
// engine's vital signs, and a real task failure leaves health alone instead
// of benching the engine forever. Scratch rooms and injected clocks only;
// the real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  engineRegistryFile,
  engineStallReason,
  engineFailureHealthStatus,
  readEngineRegistry,
  recordEngineRunHealth,
  resolveEngineForRoleRanked,
  resolveEngineForRoleWithPreference,
  resolveJobTeam,
  setEngineHealth,
} = require('../lib/engine-registry');
const fleet = require('../lib/fleet');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const TEAM = `# roster

## build
- devin, model: swe-2-max, max: 20 min
- grok, model: grok 4.7 fast, max: 30 min
- cursor
`;

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

async function withRoom(fn, { roster = TEAM } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stall-signal-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stall-signal-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude']) setEngineHealth(name, 'ready', root);
  try {
    return await fn(root, home);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function health(root, id, now) {
  return readEngineRegistry(root, { persist: false, now }).engines.find((engine) => engine.id === id).health;
}

// Write an engine's health straight into the saved registry, so timestamps
// the writers never produce (an 'error' saved before this fix) can be tested.
function stampHealth(root, id, next) {
  const file = engineRegistryFile(root);
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  const engine = registry.engines.find((entry) => entry.id === id);
  engine.health = next;
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

// Fake engine binaries on PATH, same shape as the stall-handover room: each
// writes its arguments to a log, then sleeps past its cap or prints a line
// and exits. 'connfail' prints a dropped-connection line as its own task
// output and fails: the run failed, the engine is fine.
function fakeEngines(dir, behavior) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  for (const [name, mode] of Object.entries(behavior)) {
    const body = mode === 'stall'
      ? 'sleep 30'
      : mode === 'connfail'
        ? 'echo "expected connection closed"; exit 1'
        : mode === 'fail'
          ? 'echo "2 tests failed"; exit 1'
          : 'echo "built the widget"; exit 0';
    fs.writeFileSync(path.join(bin, name), [
      '#!/bin/sh',
      'm=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--model" ]; then m="$a"; fi; prev="$a"; done',
      `echo "${name} model=$m" >> "${logFile}"`,
      body,
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  return {
    calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

function scratchWorktree(root, home) {
  spawnSync('git', ['init', '-q', root]);
  const worktree = fs.mkdtempSync(path.join(home, 'wt-'));
  spawnSync('git', ['init', '-q', worktree]);
  return worktree;
}

function ownCliFake(worktree) {
  return {
    cli: (args) => {
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${worktree}\n`, stderr: '' };
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
  };
}

function dispatchFlight(root, worktree, cli, lead) {
  return fleet.runDispatchFlight({
    root,
    taskIds: ['CLI-900'],
    engine: lead.id,
    ownCli: cli,
    installedEngines: [],
    scoutAsk: false,
    log: () => {},
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# pass 1\n# fail 0\n', stderr: '' }),
    model: lead.roster_model || '',
    maxSeconds: 1,
  });
}

test('a failed run whose own output says "connection closed" or "overloaded" is not a stall', async () => {
  await withRoom(async () => {
    assert.equal(engineStallReason({ exitCode: 1, report: 'expected connection closed' }), null);
    assert.equal(engineStallReason({ exitCode: 1, stdout: 'the model is overloaded right now' }), null);
    assert.equal(engineStallReason({ exitCode: 1, claude: { summary: 'run ended: connection closed' } }), null);
    assert.equal(engineStallReason({ exitCode: 1, claude: { receipt_text: 'overloaded, see the task log' } }), null);
    assert.equal(engineFailureHealthStatus({ status: 'errored', report: 'expected connection closed' }), null);
  });
});

test('fleet dispatch does not retry a run whose own output looks like a dropped connection', async () => {
  await withRoom(async (root, home) => {
    const worktree = scratchWorktree(root, home);
    const engines = fakeEngines(home, { devin: 'connfail', grok: 'ok', cursor: 'ok' });
    const team = resolveJobTeam('build', root).team;
    const { cli } = ownCliFake(worktree);
    const flight = await dispatchFlight(root, worktree, cli, team[0]);
    assert.equal(engines.calls().length, 1, 'the next worker must not redo the task');
    assert.equal(engines.calls()[0], 'devin model=swe-2-max');
    assert.equal(flight.results[0].engine, 'devin');
    assert.equal(flight.results[0].handover, undefined);
    assert.equal(flight.paused[0].stage, 'build');
    assert.equal(health(root, 'devin').status, 'ready');
  });
});

test('the same dropped-connection text in stderr is a stall and benches the engine', async () => {
  await withRoom(async (root) => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const stall = engineStallReason({ exitCode: 1, stderr: 'Error: connection closed by remote host' });
    assert.equal(stall.kind, 'transient');
    const updated = recordEngineRunHealth('devin', { exitCode: 1, stderr: 'Error: connection closed by remote host' }, root, { now });
    assert.equal(updated.health.status, 'cooling');
    assert.equal(updated.health.cooling_reason, 'connection dropped');
    assert.equal(resolveJobTeam('build', root, { now }).lead.id, 'grok');
    const overloaded = recordEngineRunHealth('grok', { exitCode: 1, claude: { stderr: 'service overloaded' } }, root, { now });
    assert.equal(overloaded.health.status, 'cooling');
  });
});

test('a failed run whose report says "rate limit" leaves health alone; the same text in stderr marks credit_out', async () => {
  await withRoom(async (root) => {
    const byReport = recordEngineRunHealth('devin', { exitCode: 1, report: 'the docs mention rate limit and subscription tiers' }, root);
    assert.equal(byReport, null);
    assert.equal(health(root, 'devin').status, 'ready');
    const bySummary = recordEngineRunHealth('grok', { exitCode: 1, claude: { summary: 'hit a rate limit', receipt_text: 'subscription note' } }, root);
    assert.equal(bySummary, null);
    assert.equal(health(root, 'grok').status, 'ready');
    const byStderr = recordEngineRunHealth('cursor', { exitCode: 1, stderr: 'rate limit exceeded' }, root);
    assert.equal(byStderr.health.status, 'credit_out');
    const byEvent = recordEngineRunHealth('devin', { exitCode: 1, rate_limit_info: { status: 'rejected', resetsAt: 9999999999 } }, root);
    assert.equal(byEvent.health.status, 'credit_out');
    const allowed = recordEngineRunHealth('grok', { exitCode: 1, rate_limit_info: { status: 'allowed', resetsAt: 9999999999 } }, root);
    assert.equal(allowed, null);
  });
});

test('a real task failure leaves the engine ready and still resolvable as the roster pick', async () => {
  await withRoom(async (root) => {
    const failed = recordEngineRunHealth('devin', { exitCode: 1, report: 'not ok 3 - widget renders once\n2 tests failed' }, root);
    assert.equal(failed, null);
    assert.equal(health(root, 'devin').status, 'ready');
    assert.equal(resolveJobTeam('build', root).lead.id, 'devin');
    assert.equal(resolveEngineForRoleRanked('executor', root).engine.id, 'devin');
    const preferred = resolveEngineForRoleWithPreference('executor', root, 'devin');
    assert.equal(preferred.engine.id, 'devin');
    assert.equal(preferred.engine_fallback_reason, null);
  });
});

test('an engine benched at error routes again once the window passes, and with no stamp at once', async () => {
  await withRoom(async (root) => {
    const now = Date.now();
    const old = new Date(now - 31 * 60000).toISOString();
    const fresh = new Date(now - 10 * 60000).toISOString();

    stampHealth(root, 'devin', { status: 'error', last_failure_ts: old });
    assert.equal(resolveJobTeam('build', root).lead.id, 'devin', 'an error older than the window routes again');

    stampHealth(root, 'devin', { status: 'error' });
    assert.equal(resolveJobTeam('build', root).lead.id, 'devin', 'an error with no timestamp routes at once');

    stampHealth(root, 'devin', { status: 'error', last_failure_ts: fresh });
    const team = resolveJobTeam('build', root);
    assert.equal(team.lead.id, 'grok', 'a fresh error still sits out the window');
    assert.match(team.reason, /is not ready, using backup: grok/);

    process.env.ATRIS_ENGINE_COOLDOWN_MINUTES = '5';
    stampHealth(root, 'devin', { status: 'error', last_failure_ts: new Date(now - 10 * 60000).toISOString() });
    assert.equal(resolveJobTeam('build', root).lead.id, 'devin', 'the window override comes from the same knob as cooling');
  });
});

'use strict';

// A stalled or failing worker is benched for a cooldown and the roster's next
// worker takes the job. Every room is a scratch project with a scratch home,
// and the clock is injected, so the real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineCommand } = require('../commands/engine');
const {
  readEngineRegistry,
  recordEngineRunHealth,
  resolveEngineForRoleRanked,
  setEngineHealth,
} = require('../lib/engine-registry');
const { resolveJobTeam } = require('../lib/roster');
const { recordMissionEngineTickOutcome, resolveMissionTickRunner } = require('../commands/mission');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stall-handover-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stall-handover-home-'));
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

function capture(fn) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const exit = fn();
    return { exit, out: logs.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// Fake engine binaries on PATH: each writes its arguments to a log, then
// either sleeps past its cap (a stall) or prints a report and exits.
function fakeEngines(dir, behavior) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  for (const [name, mode] of Object.entries(behavior)) {
    const body = mode === 'stall'
      ? 'sleep 30'
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

// A scratch git checkout for the engine to build in; dispatch refuses to run
// outside one.
function scratchWorktree(root, home) {
  spawnSync('git', ['init', '-q', root]);
  const worktree = fs.mkdtempSync(path.join(home, 'wt-'));
  spawnSync('git', ['init', '-q', worktree]);
  return worktree;
}

function ownCliFake(worktree) {
  const calls = [];
  return {
    calls,
    cli: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${worktree}\n`, stderr: '' };
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    },
  };
}

// The same call `atris engine dispatch --engine devin` makes when the build
// roster picks devin: the lead's own model and time cap ride along.
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

test('a timed-out lead is benched and the next resolution picks the backup', async () => {
  await withRoom(async (root) => {
    const before = resolveJobTeam('build', root);
    assert.deepEqual(before.team.map((engine) => engine.id), ['devin', 'grok', 'cursor']);
    const now = new Date('2026-09-27T12:00:00.000Z');
    const updated = recordEngineRunHealth('devin', { exitCode: null, timed_out: true, max_seconds: 1200 }, root, { now });
    assert.equal(updated.health.status, 'cooling');
    assert.equal(updated.health.cooling_until, '2026-09-27T12:30:00.000Z');
    const after = resolveJobTeam('build', root, { now });
    assert.deepEqual(after.team.map((engine) => engine.id), ['grok', 'cursor']);
    assert.equal(after.lead.roster_model, before.team[1].roster_model, 'the backup runs its own model');
    assert.match(after.reason, /cooling until \d\d:\d\d \(stalled\), using backup: grok/);
    assert.equal(resolveEngineForRoleRanked('executor', root, { now }).engine.id, 'grok');
  });
});

test('the cooldown passes and the lead returns with no human step', async () => {
  await withRoom(async (root) => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    recordEngineRunHealth('devin', { exitCode: 125 }, root, { now });
    const stillCooling = new Date('2026-09-27T12:29:00.000Z');
    const back = new Date('2026-09-27T12:31:00.000Z');
    assert.equal(resolveJobTeam('build', root, { now: stillCooling }).lead.id, 'grok');
    assert.equal(resolveJobTeam('build', root, { now: back }).lead.id, 'devin');
    assert.equal(health(root, 'devin', back).status, 'ready');
  });
});

test('the cooldown length comes from ATRIS_ENGINE_COOLDOWN_MINUTES', async () => {
  await withRoom(async (root) => {
    process.env.ATRIS_ENGINE_COOLDOWN_MINUTES = '5';
    const now = new Date('2026-09-27T12:00:00.000Z');
    const updated = recordEngineRunHealth('devin', { exitCode: 124 }, root, { now });
    assert.equal(updated.health.cooling_until, '2026-09-27T12:05:00.000Z');
    assert.equal(resolveJobTeam('build', root, { now: new Date('2026-09-27T12:06:00.000Z') }).lead.id, 'devin');
  });
});

test('a transient error cools; a real task failure changes nothing', async () => {
  await withRoom(async (root) => {
    const now = new Date('2026-09-27T12:00:00.000Z');
    const dropped = recordEngineRunHealth('devin', { exitCode: 1, stderr: 'Error: read ECONNRESET' }, root, { now });
    assert.equal(dropped.health.status, 'cooling');
    assert.equal(dropped.health.cooling_reason, 'connection dropped');
    const spawnTimeout = recordEngineRunHealth('cursor', { exitCode: 1, stderr: 'spawn ETIMEDOUT' }, root, { now });
    assert.equal(spawnTimeout.health.status, 'cooling');
    const failed = recordEngineRunHealth('grok', { exitCode: 1, report: 'not ok 3 - widget renders once\n2 tests failed' }, root, { now });
    assert.equal(failed, null);
    assert.equal(health(root, 'grok', now).status, 'ready');
  });
});

test('credit out and not installed keep today\'s behavior', async () => {
  await withRoom(async (root) => {
    const credit = recordEngineRunHealth('devin', { exitCode: 1, timed_out: true, stderr: 'usage limit reached, purchase more credits' }, root);
    assert.equal(credit.health.status, 'credit_out');
    assert.equal(credit.health.cooling_until, undefined);
    const missing = recordEngineRunHealth('grok', { exitCode: 127, stderr: 'sh: grok: command not found' }, root);
    assert.equal(missing.health.status, 'not_installed');
    assert.equal(resolveJobTeam('build', root, { now: new Date(Date.now() + 24 * 3600000) }).lead.id, 'cursor');
  });
});

test('roster view and engine list show the benched worker', async () => {
  await withRoom(async (root) => {
    recordEngineRunHealth('devin', { timed_out: true }, root);
    const until = new Date(health(root, 'devin').cooling_until);
    const clock = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
    const roster = capture(() => engineCommand(['roster'], { root }));
    assert.equal(roster.exit, 0);
    assert.match(roster.out, new RegExp(`cooling until ${clock} \\(stalled\\), using backup`));
    assert.match(roster.out, new RegExp(`1\\. .*skipped, cooling until ${clock} \\(stalled\\)`));
    assert.match(roster.out, /2\. .*leads now/);
    const list = capture(() => engineCommand([], { root }));
    assert.match(list.out, /devin\s+cooling/);
    assert.match(list.out, new RegExp(`cooling until ${clock} \\(stalled\\)`));
  });
});

test('fleet dispatch hands a stalled run to the backup with its own model and stops after success', async () => {
  await withRoom(async (root, home) => {
    const worktree = scratchWorktree(root, home);
    const engines = fakeEngines(home, { devin: 'stall', grok: 'ok', cursor: 'ok' });
    const team = resolveJobTeam('build', root).team;
    const { cli, calls } = ownCliFake(worktree);
    const flight = await dispatchFlight(root, worktree, cli, team[0]);
    const ran = engines.calls();
    assert.equal(ran.length, 2, ran.join('\n'));
    assert.equal(ran[0], 'devin model=swe-2-max');
    assert.equal(ran[1], `grok model=${team[1].roster_model}`);
    assert.equal(flight.results[0].engine, 'grok');
    assert.deepEqual(flight.results[0].handover.reasons, ['devin stalled at 1s; grok took over']);
    assert.equal(flight.paused.length, 0);
    assert.deepEqual(flight.landed.map((row) => row.task), ['CLI-900']);
    assert.ok(calls.some((call) => call.startsWith('task ready CLI-900')));
    assert.equal(health(root, 'devin').status, 'cooling');
    assert.equal(health(root, 'grok').status, 'ready');
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.deepEqual(receipt.results[0].handover.reasons, flight.results[0].handover.reasons);
  });
});

test('a team that runs out returns the last failure with every reason', async () => {
  const roster = `# roster

## build
- devin, model: swe-2-max, max: 1 s
- grok, model: grok 4.7 fast, max: 1 s
`;
  await withRoom(async (root, home) => {
    const worktree = scratchWorktree(root, home);
    const engines = fakeEngines(home, { devin: 'stall', grok: 'stall' });
    const team = resolveJobTeam('build', root).team;
    const { cli } = ownCliFake(worktree);
    const flight = await dispatchFlight(root, worktree, cli, team[0]);
    assert.equal(engines.calls().length, 2);
    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused[0].engine, 'grok');
    assert.equal(flight.paused[0].stage, 'build');
    assert.deepEqual(flight.paused[0].handover.reasons, [
      'devin stalled at 1s; grok took over',
      'grok stalled at 1s; no one left on the build team',
    ]);
    assert.equal(flight.paused[0].handover.failed_legs[0].engine, 'devin');
    assert.equal(health(root, 'grok').status, 'cooling');
  }, { roster });
});

test('a real task failure is not handed over', async () => {
  await withRoom(async (root, home) => {
    const worktree = scratchWorktree(root, home);
    const engines = fakeEngines(home, { devin: 'fail', grok: 'ok', cursor: 'ok' });
    const team = resolveJobTeam('build', root).team;
    const { cli } = ownCliFake(worktree);
    const flight = await dispatchFlight(root, worktree, cli, team[0]);
    assert.equal(engines.calls().length, 1);
    assert.equal(flight.results[0].engine, 'devin');
    assert.equal(flight.results[0].handover, undefined);
    assert.equal(flight.paused[0].stage, 'build');
    assert.equal(health(root, 'devin').status, 'ready');
  });
});

test('a mission tick after a stall picks the backup', async () => {
  await withRoom(async (root) => {
    const mission = { id: 'm-1', runner: 'auto' };
    assert.equal(resolveMissionTickRunner(mission, root).engine_id, 'devin');
    const benched = recordMissionEngineTickOutcome('devin', {
      status: 'errored',
      reason: 'claude-timeout',
      claude: { timed_out: true },
    }, root);
    assert.equal(benched.health.status, 'cooling');
    const next = resolveMissionTickRunner(mission, root);
    assert.equal(next.engine_id, 'grok');
    assert.equal(next.mission.roster_max_seconds, 1800);
    // A tick that ran out of mission wall time is not the engine's fault.
    const wall = recordMissionEngineTickOutcome('grok', {
      status: 'errored',
      reason: 'wall-exceeded-during-tick',
      claude: { timed_out: true },
    }, root);
    assert.equal(wall, null);
    assert.equal(health(root, 'grok').status, 'ready');
  });
});

test('with no roster anywhere a stalled dispatch restaffs exactly as before', async () => {
  await withRoom(async (root) => {
    assert.equal(resolveJobTeam('build', root).source, 'router');
    const engines = [];
    const { cli } = ownCliFake('/wt/dispatch-cli-900');
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      ownCli: cli,
      installedEngines: ['cursor', 'codex'],
      log: () => {},
      dispatcher: (entry) => {
        engines.push(entry.engine);
        assert.equal(entry.roster_pin, undefined);
        return Promise.resolve(entry.engine === 'cursor'
          ? { exitCode: null, timed_out: true, signal: 'SIGTERM' }
          : { exitCode: 0, report: 'done' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    });
    assert.deepEqual(engines, ['cursor', 'codex']);
    assert.equal(flight.results[0].handover, undefined);
    assert.equal(flight.results[0].restaffed.from, 'cursor');
    assert.equal(flight.results[0].restaffed.to, 'codex');
  }, { roster: '' });
});

test('an autopilot phase that stalls benches its roster worker for the next phase run', async () => {
  const roster = `# roster

## review
- codex, max: 1 s
- claude code, model: opus 5.5
`;
  await withRoom(async (root, home) => {
    const { executePhaseDetailed, buildPhaseRunnerCommand } = require('../commands/autopilot');
    fakeEngines(home, { codex: 'stall' });
    const prompt = path.join(root, 'prompt.md');
    assert.match(buildPhaseRunnerCommand('review', prompt, root), /^codex exec /);
    const cwd = process.cwd();
    process.chdir(root);
    let thrown;
    try {
      executePhaseDetailed('review', { task: 'fixture', kind: 'endgame' }, { verbose: false });
    } catch (err) {
      thrown = err;
    } finally {
      process.chdir(cwd);
    }
    assert.match(String(thrown && thrown.message), /^review phase timed out after 1s/);
    assert.equal(health(root, 'codex').status, 'cooling');
    assert.match(buildPhaseRunnerCommand('review', prompt, root), /^claude -p /);
  }, { roster });
});

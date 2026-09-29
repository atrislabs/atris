'use strict';

// The run history belongs to the project. Fleet builds, missions, asks, prep
// passes, and autopilot phases often run inside a git worktree that is
// reaped afterwards, so every recorder writes to the main checkout instead.
// Each room is a scratch repo with a real linked worktree, a scratch home,
// and fake engines on PATH; nothing outside the temp folder is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
const { readRosterRuns, appendRosterRun, rosterRunsPath } = require('../lib/roster-runs');
const fleet = require('../lib/fleet');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const TEAM = `# roster

## search
- claude, model: haiku

## build
- devin, model: swe-2-max, max: 20 min
- cursor

## review
- codex
`;

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const ENGINES = ['devin', 'grok', 'cursor', 'codex', 'claude'];

function git(cwd, args) {
  const run = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

// root is the main checkout with the roster; linked is a real `git worktree
// add` of it, the shape fleet and mission worktrees have.
async function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-main-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-wt-'));
  const linked = path.join(home, 'linked');
  git(root, ['init', '-q']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(root, ['worktree', 'add', '-q', '--detach', linked]);
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), TEAM);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  for (const dir of [root, linked]) {
    readEngineRegistry(dir);
    for (const name of ENGINES) setEngineHealth(name, 'ready', dir);
  }
  try {
    return await fn({ root, linked, bin, wt });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin, wt]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeEngine(bin, name, { stdout = '', exit = 0 } = {}) {
  const file = path.join(bin, name);
  fs.writeFileSync(`${file}.out`, stdout);
  fs.writeFileSync(file, ['#!/bin/sh', `cat "${file}.out"`, `exit ${exit}`, ''].join('\n'));
  fs.chmodSync(file, 0o755);
}

function runs(dir) {
  return readRosterRuns(dir, { now: Date.now() + 3600000, days: 3650 });
}

// The rows are in the main checkout, the worktree reads the same rows, and
// the worktree has no history file of its own to be reaped with it.
function assertRecordedInMain(root, linked) {
  const rows = runs(root);
  assert.ok(rows.length > 0, 'no run was recorded in the main checkout');
  assert.equal(fs.existsSync(path.join(linked, '.atris', 'state', 'roster_runs.jsonl')), false,
    'the run history was written inside the worktree');
  assert.deepEqual(runs(linked), rows);
  return rows;
}

function ownCli(wt) {
  return (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
}

function quietly(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
  }
}

test('a run recorded from a worktree lands in the main checkout; a worktree whose main is gone keeps its own', async () => {
  await withRoom(async ({ root, linked }) => {
    appendRosterRun(linked, { job: 'build', engine: 'devin', outcome: 'landed' });
    assert.equal(fs.realpathSync(path.dirname(rosterRunsPath(linked))), fs.realpathSync(path.join(root, '.atris', 'state')));
    assertRecordedInMain(root, linked);
  });
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runs-orphan-'));
  try {
    fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(orphan, 'gone', '.git', 'worktrees', 'x')}\n`);
    appendRosterRun(orphan, { job: 'build', engine: 'devin', outcome: 'landed' });
    assert.equal(runs(orphan).length, 1);
    assert.equal(fs.existsSync(path.join(orphan, 'gone')), false);
  } finally {
    fs.rmSync(orphan, { recursive: true, force: true });
  }
});

test('fleet dispatch from a worktree records the build in the main checkout', async () => {
  await withRoom(async ({ root, linked, bin, wt }) => {
    fakeEngine(bin, 'devin', { stdout: 'built the widget\n' });
    const flight = await fleet.runDispatchFlight({
      root: linked,
      taskIds: ['CLI-900'],
      engine: 'devin',
      installedEngines: [],
      model: 'swe-2-max',
      ownCli: ownCli(wt),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      scoutAsk: false,
      log: () => {},
    });
    assert.equal(flight.landed.length, 1);
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome, row.source]), [['build', 'devin', 'landed', 'dispatch']]);
  });
});

test('a one-lap review from a worktree records every validator attempt in the main checkout', async () => {
  await withRoom(async ({ root, linked, wt }) => {
    const flight = await fleet.runDispatchFlight({
      root: linked,
      taskIds: ['CLI-900'],
      engine: 'cursor',
      reviewOnly: true,
      verifierCommand: 'node --test test/widget.test.js',
      receiptContext: { source: 'one_lap', objective: 'Fix the widget' },
      ownCli: (args) => {
        if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
        if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'built the widget' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      validatorEngines: ['claude'],
      validatorDispatcher: () => Promise.resolve({ exitCode: 0, report: 'read the diff\nSIGNOFF: widget renders once' }),
      validatorStateInspector: () => ({ ok: true, head: 'abc', digest: 'clean-state' }),
      changeInspector: () => ({ has_change: true, base: 'a', head: 'b', commit: 'b', dirty: false }),
      scoutAsk: false,
      log: () => {},
    });
    assert.equal(flight.ready.length, 1);
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome]), [
      ['review', 'claude', 'landed'],
      ['build', 'cursor', 'landed'],
    ]);
  });
});

test('a mission blocker dispatch recorded from a worktree lands in the main checkout', async () => {
  await withRoom(async ({ root, linked }) => {
    fleet.recordDispatchOutcome(linked, {
      engine: 'devin',
      pin: { model: 'swe-2-max' },
      startedMs: NOW,
      endedMs: NOW + 60000,
      result: { exitCode: 0, report: 'built the widget' },
      task: 'CLI-900',
      source: 'mission blocker',
    });
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.engine, row.model, row.outcome, row.source]), [['devin', 'swe-2-max', 'landed', 'mission blocker']]);
  });
});

test('a mission tick run in its worktree records in the main checkout', async () => {
  const { recordMissionTickRosterRun } = require('../commands/mission');
  await withRoom(async ({ root, linked }) => {
    recordMissionTickRosterRun(linked, {
      mission: { id: 'm-7', owner: 'fixer' },
      runtimeMission: { id: 'm-7', runner: 'devin', model: 'swe-2-max' },
      engineId: 'devin',
      result: { status: 'ran' },
      verifierResult: { passed: true },
      startedAt: new Date(NOW).toISOString(),
      endedMs: NOW + 300000,
    });
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.member, row.engine, row.outcome, row.source]), [['fixer', 'devin', 'landed', 'mission']]);
  });
});

test('an engine ask from a worktree records in the main checkout', async () => {
  const { runEngineAskCommand } = require('../lib/engine-ask');
  await withRoom(async ({ root, linked, bin }) => {
    fakeEngine(bin, 'claude', { stdout: 'the answer is 42\n' });
    const code = await quietly(() => runEngineAskCommand(['what is the answer', '--engine', 'claude'], linked));
    assert.equal(code, 0);
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome, row.source]), [['ask', 'claude', 'landed', 'ask']]);
  });
});

test('a prep pass from a worktree records in the main checkout', async () => {
  const { runPrepPass } = require('../lib/roster-prep');
  await withRoom(async ({ root, linked }) => {
    const prep = await runPrepPass({
      prepJob: 'search',
      forJob: 'build',
      task: TASK,
      prompt: 'fix the widget',
      root: linked,
      ask: async () => ({ ok: true, stdout: 'the widget lives in lib/widget.js\n' }),
    });
    assert.equal(prep.ok, true, prep.reason);
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome, row.source]), [['search', 'claude', 'landed', 'prep']]);
  });
});

test('an autopilot phase run from a worktree records in the main checkout', async () => {
  const { executePhaseDetailed } = require('../commands/autopilot');
  await withRoom(async ({ root, linked, bin }) => {
    fakeEngine(bin, 'codex', { stdout: 'SIGNOFF\n' });
    const cwd = process.cwd();
    process.chdir(linked);
    try {
      executePhaseDetailed('review', { task: 'fixture', kind: 'endgame' }, { verbose: false });
    } finally {
      process.chdir(cwd);
    }
    const rows = assertRecordedInMain(root, linked);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.outcome, row.source]), [['review', 'codex', 'landed', 'autopilot']]);
  });
});

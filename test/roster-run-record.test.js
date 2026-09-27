'use strict';

// Every run launched from a roster pick records one line: when, job, member,
// engine, model, effort, time cap, seconds, outcome, and tokens when the tool
// reports them. Every room is a scratch project with a scratch home, the
// clock is injected, and fake engines sit on PATH, so the real ~/.atris is
// never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
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
- cursor
`;

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

async function withRoom(fn, { roster = TEAM } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-record-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-record-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-record-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-run-record-wt-'));
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, home, bin, wt });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin, wt]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fake engine binary: prints stdout and stderr, then exits with a code.
function fakeEngine(bin, name, { stdout = '', stderr = '', exit = 0 } = {}) {
  const file = path.join(bin, name);
  fs.writeFileSync(`${file}.out`, stdout);
  fs.writeFileSync(`${file}.err`, stderr);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `cat "${file}.out"`,
    `cat "${file}.err" >&2`,
    `exit ${exit}`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

function ownCli(wt) {
  return (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
}

function health(root, id) {
  return readEngineRegistry(root, { persist: false }).engines.find((engine) => engine.id === id).health.status;
}

function dispatchFlight(root, wt, options = {}) {
  return fleet.runDispatchFlight({
    root,
    taskIds: ['CLI-900'],
    engine: 'cursor',
    installedEngines: ['cursor'],
    ownCli: ownCli(wt),
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
    scoutAsk: false,
    log: () => {},
    ...options,
  });
}

test('"rate limit" in a failed run\'s own output leaves the engine ready; the same text on stderr marks credit_out', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stdout: 'rate limit test failed\n', exit: 1 });
    const flight = await dispatchFlight(root, wt);
    assert.equal(flight.paused[0].stage, 'build');
    assert.notEqual(flight.paused[0].reason, 'usage_limit');
    assert.equal(health(root, 'cursor'), 'ready');
  });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stdout: 'working\n', stderr: 'rate limit test failed\n', exit: 1 });
    const flight = await dispatchFlight(root, wt);
    assert.equal(flight.paused[0].reason, 'usage_limit');
    assert.equal(health(root, 'cursor'), 'credit_out');
  });
});

const { readRosterRuns, appendRosterRun, rosterRunsPath } = require('../lib/roster-runs');
const { engineCommand } = require('../commands/engine');

const NOW = Date.parse('2026-09-27T12:00:00.000Z');

// Each call moves the clock 90 seconds, so every attempt takes 90 seconds.
function stepClock(start = NOW, step = 90000) {
  let at = start;
  return () => {
    const value = at;
    at += step;
    return value;
  };
}

function runs(root) {
  return readRosterRuns(root, { now: NOW + 3600000 });
}

function command(root, args) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now: new Date(NOW + 3600000) });
    return { exit, out: logs.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('a successful dispatch records landed with its engine, model, time cap, and seconds', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'devin', { stdout: 'built the widget\n' });
    const flight = await dispatchFlight(root, wt, {
      engine: 'devin',
      installedEngines: [],
      model: 'swe-2-max',
      maxSeconds: 1200,
      clock: stepClock(),
    });
    assert.equal(flight.landed.length, 1);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      at: '2026-09-27T12:00:00.000Z',
      job: 'build',
      engine: 'devin',
      outcome: 'landed',
      model: 'swe-2-max',
      task: 'CLI-900',
      source: 'dispatch',
      max_seconds: 1200,
      seconds: 90,
    });
  });
});

test('a stalled lead and a successful backup record two lines: stalled and handed over, then landed', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fs.writeFileSync(path.join(bin, 'devin'), '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(path.join(bin, 'devin'), 0o755);
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    const flight = await dispatchFlight(root, wt, {
      engine: 'devin',
      installedEngines: [],
      model: 'swe-2-max',
      maxSeconds: 1,
      clock: stepClock(),
    });
    assert.equal(flight.landed.length, 1);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.engine, row.outcome, row.handed_over_to || '']), [
      ['devin', 'stalled', 'cursor'],
      ['cursor', 'landed', ''],
    ]);
    assert.equal(rows[0].detail, 'stalled at 1s');
    assert.equal(rows[0].max_seconds, 1);
    assert.equal(rows[1].at, '2026-09-27T12:03:00.000Z');
    const listed = command(root, ['roster', '--runs']);
    assert.match(listed.out, /devin swe-2-max \(1 min 30s|devin swe-2-max \(/);
    assert.match(listed.out, /stalled at 1s, handed over to cursor/);
  });
});

test('a real task failure records failed with the task reason; "rate limit" in the output is not credit out', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stdout: '2 tests failed\n', exit: 1 });
    await dispatchFlight(root, wt, { clock: stepClock() });
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'failed');
    assert.equal(rows[0].detail, '2 tests failed');
  });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stdout: 'rate limit test failed\n', exit: 1 });
    await dispatchFlight(root, wt, { clock: stepClock() });
    assert.deepEqual(runs(root).map((row) => row.outcome), ['failed']);
    assert.equal(health(root, 'cursor'), 'ready');
  });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stderr: 'rate limit reached\n', exit: 1 });
    await dispatchFlight(root, wt, { clock: stepClock() });
    assert.deepEqual(runs(root).map((row) => row.outcome), ['credit out']);
  });
});

test('tokens come from the tool\'s own usage line, and stay empty when it prints none', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'codex', { stdout: 'built the widget\n', stderr: 'tokens used\n12,345\n' });
    await dispatchFlight(root, wt, { engine: 'codex', installedEngines: [], clock: stepClock() });
    const [row] = runs(root);
    assert.equal(row.outcome, 'landed');
    assert.equal(row.tokens, 12345);
  });
  await withRoom(async ({ root, bin, wt }) => {
    const usage = JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 }, total_cost_usd: 0.42 });
    fakeEngine(bin, 'claude', { stdout: `${usage}\n` });
    await dispatchFlight(root, wt, { engine: 'claude', installedEngines: [], clock: stepClock() });
    const [row] = runs(root);
    assert.equal(row.tokens, 1250);
    assert.equal(row.cost_usd, 0.42);
  });
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'cursor-agent', { stdout: 'built the widget\n' });
    await dispatchFlight(root, wt, { clock: stepClock() });
    const [row] = runs(root);
    assert.equal(row.outcome, 'landed');
    assert.equal('tokens' in row, false);
    assert.equal('cost_usd' in row, false);
  });
});

function seed(root, rows) {
  for (const row of rows) appendRosterRun(root, row);
}

test('the roster shows each worker\'s recent record, and nothing when there are no records', async () => {
  await withRoom(async ({ root }) => {
    const before = command(root, ['roster']);
    assert.equal(before.exit, 0);
    assert.doesNotMatch(before.out, /last 7 days/);
    const beforeJson = JSON.parse(command(root, ['roster', '--json']).out);
    assert.ok(beforeJson.jobs.every((row) => row.workers.every((worker) => !worker.record)));

    const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
    seed(root, [
      { at: at(300), job: 'build', engine: 'devin', model: 'swe-2-max', outcome: 'landed', seconds: 600 },
      { at: at(200), job: 'build', engine: 'devin', model: 'swe-2-max', outcome: 'stalled', detail: 'stalled at 20 min', handed_over_to: 'cursor', seconds: 1200 },
      { at: at(199), job: 'build', engine: 'cursor', outcome: 'landed', seconds: 300 },
      { at: at(100), job: 'build', engine: 'devin', model: 'swe-2-max', outcome: 'failed', detail: '2 tests failed', seconds: 660 },
      { at: at(60 * 24 * 10), job: 'build', engine: 'devin', model: 'swe-2-max', outcome: 'landed', seconds: 60 },
      { at: at(50), job: 'search', engine: 'devin', model: 'swe-2-max', outcome: 'landed', seconds: 30 },
    ]);
    const view = command(root, ['roster']);
    assert.match(view.out, /: last 7 days: 3 runs, 1 landed, 1 stalled, 1 failed, median 11 min/);
    assert.match(view.out, /: last 7 days: 1 run, 1 landed, median 5 min/);
    const json = JSON.parse(command(root, ['roster', '--json']).out);
    const build = json.jobs.find((row) => row.job === 'build');
    const devin = build.workers.find((worker) => worker.engine === 'devin');
    assert.equal(devin.record.runs, 3);
    assert.equal(devin.record.landed, 1);
    assert.equal(devin.record.stalled, 1);
    assert.equal(devin.record.failed, 1);
    assert.equal(devin.record.handed_over, 1);
    assert.equal(devin.record.median_seconds, 660);
  });
});

test('--runs lists attempts newest first, at most 20, and can pick one job', async () => {
  await withRoom(async ({ root }) => {
    assert.match(command(root, ['roster', '--runs']).out, /^no runs recorded in the last 30 days$/);
    const rows = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push({ at: new Date(NOW - (25 - i) * 60000).toISOString(), job: i % 5 === 0 ? 'review' : 'build', engine: 'cursor', outcome: 'landed', seconds: i, task: `CLI-${i}` });
    }
    seed(root, rows);
    const listed = command(root, ['roster', '--runs']);
    const lines = listed.out.split('\n');
    assert.equal(lines[0], 'recent runs, newest first');
    assert.equal(lines.length, 21);
    assert.match(lines[1], /CLI-24/);
    assert.match(lines[20], /CLI-5\b/);
    const review = command(root, ['roster', '--runs', 'review']).out.split('\n');
    assert.equal(review[0], 'recent review runs, newest first');
    assert.deepEqual(review.slice(1).map((line) => /CLI-\d+/.exec(line)[0]), ['CLI-20', 'CLI-15', 'CLI-10', 'CLI-5', 'CLI-0']);
    const json = JSON.parse(command(root, ['roster', '--runs', '--json']).out);
    assert.equal(json.runs.length, 20);
    assert.equal(json.runs[0].task, 'CLI-24');
  });
});

test('a corrupt line or a missing file is skipped, never an error', async () => {
  await withRoom(async ({ root }) => {
    assert.deepEqual(runs(root), []);
    appendRosterRun(root, { at: new Date(NOW).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', seconds: 60 });
    fs.appendFileSync(rosterRunsPath(root), '{"at": "2026-09-27T12:01:00.000Z", "engine": "grok", \nnot json at all\n{"engine":"grok","outcome":"exploded","at":"2026-09-27T12:02:00.000Z"}\n');
    appendRosterRun(root, { at: new Date(NOW + 180000).toISOString(), job: 'build', engine: 'cursor', outcome: 'failed', seconds: 60 });
    assert.deepEqual(runs(root).map((row) => row.engine), ['devin', 'cursor']);
    const view = command(root, ['roster', '--runs']);
    assert.equal(view.exit, 0);
    assert.equal(view.out.split('\n').length, 3);
  });
});

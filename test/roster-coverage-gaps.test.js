'use strict';

// The places the roster did not reach yet: prep in mission ticks and
// autopilot phases, tokens from claude in fleet, effort and a run line for
// engine ask, and health plus a run line for a mission blocker's build.
// Every room is a scratch project with a scratch home, fake engines sit on
// PATH, and the real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const BRIEF = '- lib/widget.js:12 renders twice here\n- test/widget.test.js:3 the check';

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

async function withRoom(fn, { roster = '' } = {}) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coverage-gaps-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coverage-gaps-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coverage-gaps-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-coverage-gaps-wt-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['init', '-q', wt]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
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

// A fake engine: logs that it ran and every argument it got (the prompt
// rides in as an argument), then prints its output. `json` is printed instead
// when the launch asks for --output-format json.
function fakeEngine(bin, name, { stdout = '', json = '', exit = 0 } = {}) {
  const file = path.join(bin, name);
  fs.writeFileSync(`${file}.out`, stdout);
  fs.writeFileSync(`${file}.json`, json);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "${name}" >> "${path.join(bin, 'calls.log')}"`,
    `printf '%s\\n' "$@" > "${file}.args"`,
    `if [ -s "${file}.json" ]; then for a in "$@"; do if [ "$a" = "--output-format" ]; then cat "${file}.json"; exit ${exit}; fi; done; fi`,
    `cat "${file}.out"`,
    `exit ${exit}`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

function calls(bin) {
  const file = path.join(bin, 'calls.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function argsOf(bin, name) {
  const file = path.join(bin, `${name}.args`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function runs(root) {
  return require('../lib/roster-runs').readRosterRuns(root, { now: Date.now() + 3600000 });
}

function health(root, id) {
  const { readEngineRegistry } = require('../lib/engine-registry');
  return readEngineRegistry(root, { persist: false }).engines.find((engine) => engine.id === id).health;
}

// --- 1. mission ticks -------------------------------------------------------

test('a mission tick whose build worker has prep runs the search lead first and records both lines', async () => {
  const roster = '# roster\n\n## search\n- claude, model: haiku, max: 2 min\n\n## build\n- cursor, prep: search\n';
  await withRoom(async ({ root, home, bin }) => {
    fakeEngine(bin, 'claude', { stdout: `${BRIEF}\n` });
    fakeEngine(bin, 'cursor-agent', { stdout: 'cursor finished the tick\n' });
    const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: home };
    const cli = (args) => spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8', env, timeout: 90000 });
    const started = cli(['mission', 'start', 'make the widget render once', '--runner', 'auto', '--no-verify', '--json']);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const ran = cli(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json']);
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
    assert.deepEqual(calls(bin), ['claude', 'cursor-agent']);
    assert.match(argsOf(bin, 'claude'), /prep pass for a heavier build worker/);
    assert.match(argsOf(bin, 'claude'), /make the widget render once/);
    const prompt = argsOf(bin, 'cursor-agent');
    assert.match(prompt, /## brief from the prep pass \(search, claude\)/);
    assert.match(prompt, /lib\/widget\.js:12 renders twice here/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.source, row.outcome]), [
      ['search', 'claude', 'prep', 'landed'],
      ['build', 'cursor', 'mission', 'landed'],
    ]);
    assert.equal(rows[0].task, mission.id);
    assert.equal(rows[1].task, mission.id);
    assert.equal(rows[1].prep, 'prepped by search');
    assert.equal(rows[1].brief_bytes, Buffer.byteLength(BRIEF));
  }, { roster });
});

test('a mission tick with no prep line sends its prompt as it was', async () => {
  const { missionTickPrep } = require('../commands/mission');
  let asked = 0;
  const same = await missionTickPrep(process.cwd(), {
    mission: { id: 'm-1' },
    runtimeMission: { runner: 'cursor' },
    prompt: 'do the tick',
    ask: async () => { asked += 1; return { ok: true, stdout: BRIEF }; },
  });
  assert.deepEqual(same, { prompt: 'do the tick', prep: null });
  assert.equal(asked, 0);
});

// --- 2. autopilot phases ----------------------------------------------------

test('an autopilot phase whose worker has prep reads the brief first and records both lines', async () => {
  const roster = '# roster\n\n## search\n- claude, max: 2 min\n\n## review\n- codex, prep: search\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: `${BRIEF}\n` });
    fakeEngine(bin, 'codex', { stdout: 'SIGNOFF\ntokens used\n812\n' });
    const { executePhaseDetailed } = require('../commands/autopilot');
    const cwd = process.cwd();
    process.chdir(root);
    let result;
    try {
      result = executePhaseDetailed('review', { task: 'fix the widget', kind: 'endgame' }, { verbose: false });
    } finally {
      process.chdir(cwd);
    }
    assert.deepEqual(calls(bin), ['claude', 'codex']);
    assert.match(argsOf(bin, 'claude'), /prep pass for a heavier review worker/);
    assert.match(argsOf(bin, 'codex'), /## brief from the prep pass \(search, claude\)/);
    assert.match(result.prompt, /lib\/widget\.js:12 renders twice here/);
    const rows = runs(root);
    assert.deepEqual(rows.map((row) => [row.job, row.engine, row.source, row.outcome]), [
      ['search', 'claude', 'prep', 'landed'],
      ['review', 'codex', 'autopilot', 'landed'],
    ]);
    assert.equal(rows[0].task, 'autopilot review');
    assert.equal(rows[1].prep, 'prepped by search');
    assert.equal(rows[1].tokens, 812);
  }, { roster });
});

// --- 3. claude tokens in fleet ----------------------------------------------

function ownCli(wt) {
  return (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(TASK), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${wt}\n`, stderr: '' };
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
}

const CLAUDE_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'built the widget',
  usage: { input_tokens: 1000, output_tokens: 234, cache_read_input_tokens: 66 },
  total_cost_usd: 0.05,
});

test('a fleet claude run records tokens and cost from its result JSON, and the report stays its text', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: 'plain text answer\n', json: `${CLAUDE_RESULT}\n` });
    const fleet = require('../lib/fleet');
    const direct = fleet.dispatchToEngine({ task: TASK, engine: 'claude', worktreePath: wt, root, skipBriefCapture: true });
    assert.match(argsOf(bin, 'claude'), /--output-format\njson/);
    assert.equal(direct.report, 'built the widget');
    assert.equal(direct.exitCode, 0);
    const flight = await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-900'],
      engine: 'claude',
      installedEngines: [],
      ownCli: ownCli(wt),
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: '# pass 1\n', stderr: '' }),
      scoutAsk: false,
      log: () => {},
    });
    assert.equal(flight.landed.length, 1);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].engine, rows[0].outcome, rows[0].tokens, rows[0].cost_usd], ['claude', 'landed', 1300, 0.05]);
  });
});

test('a claude stand-in that prints plain text still lands, with no tokens', async () => {
  await withRoom(async ({ root, bin, wt }) => {
    fakeEngine(bin, 'claude', { stdout: 'plain text answer\n' });
    const fleet = require('../lib/fleet');
    const direct = fleet.dispatchToEngine({ task: TASK, engine: 'claude', worktreePath: wt, root, skipBriefCapture: true });
    assert.equal(direct.report, 'plain text answer\n');
    assert.equal('usage' in direct, false);
  });
});

// --- 4. engine ask ------------------------------------------------------------

test('engine ask passes the search line\'s model and effort, and records an ask run line', async () => {
  const roster = '# roster\n\n## search\n- claude, model: haiku, effort: low\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: `the answer is 42\n${CLAUDE_RESULT}\n` });
    const { runEngineAskCommand } = require('../lib/engine-ask');
    const logs = [];
    const originalLog = console.log;
    console.log = (...parts) => logs.push(parts.join(' '));
    let code;
    try {
      code = await runEngineAskCommand(['what is the answer', '--engine', 'claude'], root);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0, logs.join('\n'));
    assert.match(argsOf(bin, 'claude'), /\n--model\nhaiku\n--effort\nlow\n--tools\n/);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].job, rows[0].engine, rows[0].model, rows[0].effort, rows[0].outcome, rows[0].source, rows[0].tokens],
      ['ask', 'claude', 'haiku', 'low', 'landed', 'ask', 1300]);
  }, { roster });
});

test('an ask whose engine is not on the search line runs as before and still records its line', async () => {
  const roster = '# roster\n\n## search\n- claude, model: haiku, effort: low\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'codex', { stdout: 'boom\n', exit: 3 });
    const { runEngineAskCommand } = require('../lib/engine-ask');
    const originalLog = console.log;
    console.log = () => {};
    let code;
    try {
      code = await runEngineAskCommand(['what is the answer', '--engine', 'codex'], root);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 1);
    assert.match(argsOf(bin, 'codex'), /^exec\n--sandbox\nread-only\n/);
    const rows = runs(root);
    assert.deepEqual([rows[0].job, rows[0].engine, rows[0].outcome, 'effort' in rows[0]], ['ask', 'codex', 'failed', false]);
  }, { roster });
});

test('claude takes effort as --effort, and an engine with no effort flag gets none', () => {
  const { buildReadOnlyEngineInvocation } = require('../lib/engine-ask');
  const claude = buildReadOnlyEngineInvocation('claude', 'q', 'claude-haiku-4-5', { effort: 'low' });
  assert.deepEqual(claude.args.slice(2, 6), ['--model', 'claude-haiku-4-5', '--effort', 'low']);
  const cursor = buildReadOnlyEngineInvocation('cursor', 'q', '', { effort: 'high' });
  assert.equal(cursor.args.includes('high'), false);
});

// --- 5. mission blocker dispatch ----------------------------------------------

function blockerDeps(root, dispatched) {
  const rows = [];
  let at = Date.parse('2026-09-27T12:00:00.000Z');
  return {
    taskDb: {
      open: () => ({}),
      workspaceRoot: () => root,
      listTasks: () => rows,
      withTaskDisplayRefs: (tasks) => tasks.map((task, index) => ({ ...task, display_id: `CLI-${index + 1}` })),
      addTask: (_db, input) => {
        const task = { id: `task-${rows.length + 1}`, status: 'open', created_at: 1, updated_at: 1, ...input };
        rows.push(task);
        return { id: task.id, inserted: true };
      },
      getTask: (_db, id) => rows.find((row) => row.id === id),
      noteTask: () => ({ noted: true }),
      claimTask: (_db, { id }) => ({ claimed: true, row: rows.find((row) => row.id === id) }),
      taskProjection: () => ({ tasks: [] }),
    },
    resolveEngineForRole: () => ({ id: 'codex', roster_max_seconds: 1200 }),
    createAgentWorktree: () => ({ path: path.join(root, 'wt') }),
    dispatchToEngine: () => dispatched,
    loadSwarloApiKey: () => null,
    httpPost: () => { throw new Error('unexpected network call in test'); },
    clock: () => { const value = at; at += 1200000; return value; },
  };
}

test('a mission blocker build that stalls benches its engine and records a stalled line', async () => {
  await withRoom(async ({ root }) => {
    const { handleMissionBlocker } = require('../lib/self-drive');
    const out = handleMissionBlocker({
      mission: { id: 'mission-1', owner: 'fixer', objective: 'ship reliable missions', status: 'paused' },
      stopReason: 'repeated-error:runner-failed',
      workspaceRoot: root,
    }, blockerDeps(root, { exitCode: null, timed_out: true, report: '', stderr: '' }));
    assert.equal(out.dispatched, true);
    assert.equal(out.outcome, 'stalled');
    assert.equal(health(root, 'codex').status, 'cooling');
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].job, rows[0].engine, rows[0].outcome, rows[0].detail, rows[0].source, rows[0].member, rows[0].task, rows[0].seconds],
      ['build', 'codex', 'stalled', 'stalled at 20 min', 'mission blocker', 'fixer', 'CLI-1', 1200]);
  });
});

test('a mission blocker build that lands keeps its engine ready and records landed', async () => {
  await withRoom(async ({ root }) => {
    const { handleMissionBlocker } = require('../lib/self-drive');
    const out = handleMissionBlocker({
      mission: { id: 'mission-2', objective: 'ship reliable missions', status: 'paused' },
      stopReason: 'repeated-error:runner-failed',
      workspaceRoot: root,
    }, blockerDeps(root, { exitCode: 0, report: 'fixed it\ntokens used\n300\n', stderr: '' }));
    assert.equal(out.outcome, 'landed');
    assert.equal(health(root, 'codex').status, 'ready');
    const rows = runs(root);
    assert.deepEqual([rows[0].outcome, rows[0].tokens], ['landed', 300]);
  });
});

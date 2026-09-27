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
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `printf '%s' ${JSON.stringify(stdout)}`,
    `printf '%s' ${JSON.stringify(stderr)} >&2`,
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

// The real dispatcher, so the fake engine binary on PATH really runs.
function realDispatcher(root) {
  return (entry) => fleet.dispatchToEngine({
    task: entry.task,
    engine: entry.engine,
    worktreePath: entry.worktreePath,
    root,
    prompt: entry.prompt,
    skipBriefCapture: true,
    ...(entry.roster_pin ? { model: entry.roster_pin.model, effort: entry.roster_pin.effort, maxSeconds: entry.roster_pin.maxSeconds } : {}),
  });
}

function dispatchFlight(root, wt, options = {}) {
  return fleet.runDispatchFlight({
    root,
    taskIds: ['CLI-900'],
    engine: 'cursor',
    installedEngines: ['cursor'],
    ownCli: ownCli(wt),
    dispatcher: realDispatcher(root),
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

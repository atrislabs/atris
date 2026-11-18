'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../../lib/fleet');
const tasks = require('../../lib/task-db');
const { historyStore, watchGit } = require('./pick-history');
const HOUR = 3600000;
const START = Date.parse('2026-11-01T00:00:00Z');
const FIRST = START + 2 * HOUR;

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.

// A folder to fly from, and a task store of its own that holds the made-up history.
function room(t, storeOptions) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-fleet-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const app = path.join(ws, 'app');
  // An atris folder lets the engine registry save what it learns about each engine.
  fs.mkdirSync(path.join(app, 'atris'), { recursive: true });
  return { ws, app, store: historyStore(t, app, storeOptions) };
}

const jobTitle = (n) => `Fix form ${n} so it keeps what was typed. Done: it keeps input. Check: node --test test/form${n}.test.js. Edits lib/form${n}.js`;
const job = (n, extra = {}) => ({ id: `row-${n}`, display_id: `F-${n}`, status: 'open', title: jobTitle(n), ...extra });
const jobs = (n) => Array.from({ length: n }, (_, i) => job(i + 1));

// The task list file the flights read. Each job is in this folder's workspace, the way the task command shows it.
function listJobs(app, rows) {
  const file = path.join(app, '.atris', 'state', 'tasks.projection.json');
  const workspace = tasks.workspaceRoot(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ tasks: rows.map((row) => ({ workspace_root: workspace, ...row })) })}\n`);
}

// Codex has landed everything it was given since steering began; claude has dropped everything.
function codexIsStrong(store, n = 12) {
  store.plays(n, { member: 'fleet-codex', outcome: 'landed', at: FIRST });
  store.plays(n, { member: 'fleet-claude', outcome: 'dropped', at: FIRST });
}

async function dryFlight(app, rows, options = {}) {
  listJobs(app, rows);
  const logs = [];
  const flight = await fleet.runFleetFlight({
    root: app, slots: 6, engines: ['claude', 'codex'], dryRun: true, log: (line = '') => logs.push(String(line)), ...options,
  });
  return { flight, logs };
}

// A live flight with stand-ins for the task commands, the engines and the landing.
async function liveFlight(app, rows, options = {}) {
  listJobs(app, rows);
  const logs = [];
  const asked = [];
  const calls = [];
  const flight = await fleet.runFleetFlight({
    root: app,
    slots: 6,
    engines: ['claude', 'codex'],
    log: (line = '') => logs.push(String(line)),
    ownCli: (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: `next: cd ${app}/wt-${args[args.indexOf('--task') + 1]}\n`, stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    dispatcher: (entry) => {
      asked.push([entry.task.display_id, entry.engine]);
      return Promise.resolve(options.answer ? options.answer(entry) : { exitCode: 0, report: 'built it' });
    },
    lander: () => ({ ok: true, stage: 'shipped' }),
    guardCliLink: () => ({ ok: true, changed: false }),
    scoutAsk: false,
    ...options.flight,
  });
  return { flight, logs, asked, calls };
}

// Fake engine programs on PATH, so the real roster sees these engines as installed.
function fakeEngines(dir, names) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return bin;
}
const tidyPath = (bin) => `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
const isolated = (ws, bin) => ({ PATH: tidyPath(bin), ATRIS_MACHINE_ROSTER_PATH: path.join(ws, 'machine-roster.json'), ATRIS_ROUTER_EXPLAIN: '0' });
// ...and the owner's own roster file, home folder and Claude settings are not read either.
const isolatedHome = (ws, bin) => ({
  ...isolated(ws, bin),
  HOME: path.join(ws, 'home'),
  ATRIS_MACHINE_ROSTER_MD_PATH: path.join(ws, 'machine-ROSTER.md'),
  ATRIS_ROSTER_SESSION: undefined,
  ATRIS_RUNNER_MODEL: undefined,
  ATRIS_CLAUDE_MODEL: undefined,
  ATRIS_CLAUDE_SPEND_OK: undefined,
  ATRIS_CLAUDE_KEY_OK: undefined,
  ATRIS_RUNNER_PROFILE: undefined,
  ATRIS_RUNNER_BIN: undefined,
  ATRIS_CLAUDE_BIN: undefined,
  ATRIS_RUNNER_COMMAND_TEMPLATE: undefined,
  ATRIS_CLAUDE_COMMAND_TEMPLATE: undefined,
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_MODEL: undefined,
  ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
  ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
});

module.exports = {
  HOUR,
  START,
  FIRST,
  withEnv,
  room,
  job,
  jobs,
  codexIsStrong,
  dryFlight,
  liveFlight,
  fakeEngines,
  isolated,
  isolatedHome,
  jobTitle,
  listJobs,
};

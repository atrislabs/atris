'use strict';

// Regression tests for four confirmed bugs: a lock wait that could spin
// forever, run lines lost when the lock could not be taken, a suggested
// reorder that rewrote the demoted worker, and one landed dispatch counted
// as two receipts. Rooms are scratch projects with scratch homes and an
// injected clock; the real ~/.atris is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
];

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const ROSTER_RUNS_LIB = path.join(__dirname, '..', 'lib', 'roster-runs');

async function withRoom(fn, { roster = null, registry = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-suggest-fixes-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-suggest-fixes-home-'));
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_CODEX_CONFIG_PATH = path.join(home, 'no-codex-config.toml');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  if (registry) {
    const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
    readEngineRegistry(root);
    for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude']) setEngineHealth(name, 'ready', root);
  }
  try {
    return await fn({ root, home });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function command(root, args, now = NOW) {
  const { engineCommand } = require('../commands/engine');
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now: new Date(now) });
    return { exit, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const {
  appendRosterRun,
  readRosterRuns,
  rosterRunsPath,
  RUNS_LOCK_WAIT_MS,
  RUNS_ROTATE_BYTES,
} = require('../lib/roster-runs');

// A lock holder that cannot die: a directory in the lock's place, stamped
// older than the stale window. Creating it returns EEXIST, stat reads fine,
// and removing it throws, which is exactly the stuck-lock shape.
function stuckLock(file) {
  const lock = `${file}.lock`;
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  return lock;
}

// The lock held by a live writer: a fresh lock file, not yet stale.
function heldLock(file) {
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, `${process.pid + 4242}\n`);
  return lock;
}

// One append in a worker, so a wait that never ends fails the test at `ms`
// instead of freezing the suite the way it froze the command.
function appendInWorker(root, input, ms) {
  const source = `
    const { appendRosterRun } = require(${JSON.stringify(ROSTER_RUNS_LIB)});
    const record = appendRosterRun(${JSON.stringify(root)}, ${JSON.stringify(input)});
    require('node:worker_threads').parentPort.postMessage(record);
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true });
    const killer = setTimeout(() => {
      worker.terminate().then(() => reject(new Error(`append did not return within ${ms} ms`)));
    }, ms);
    worker.once('message', (record) => {
      clearTimeout(killer);
      resolve(record);
    });
    worker.once('error', (error) => {
      clearTimeout(killer);
      reject(error);
    });
  });
}

test('a stale lock that cannot be removed stops waiting instead of spinning forever', async () => {
  await withRoom(async ({ root }) => {
    const file = rosterRunsPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stuckLock(file);
    const record = await appendInWorker(root, {
      at: new Date(NOW - 60000).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', seconds: 60,
    }, RUNS_LOCK_WAIT_MS + 8000);
    assert.ok(record, 'recording still returns the record');
    const rows = readRosterRuns(root, { now: NOW + 3600000 });
    assert.deepEqual(rows.map((row) => row.engine), ['devin']);
  });
});

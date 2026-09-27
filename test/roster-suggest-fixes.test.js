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

const pendingPath = (root) => path.join(root, '.atris', 'state', 'roster_runs.pending.jsonl');

test('a line written while the lock is held lands in the pending file, stays visible, and folds into the log', async () => {
  await withRoom(async ({ root }) => {
    const file = rosterRunsPath(root);
    const pending = pendingPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = heldLock(file);
    const first = await appendInWorker(root, {
      at: new Date(NOW - 3600000).toISOString(), job: 'build', engine: 'devin', outcome: 'landed', task: 'CLI-1', seconds: 60,
    }, RUNS_LOCK_WAIT_MS + 8000);
    assert.ok(first, 'recording never throws');
    // The line waited out the lock and went to the side file, not the log.
    assert.ok(fs.existsSync(pending), 'the append lands in the pending file');
    assert.equal(fs.readFileSync(pending, 'utf8').trim().split('\n').length, 1);
    const logText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    assert.doesNotMatch(logText, /CLI-1/, 'nothing is written past the lock into the log');
    // The reader sees it anyway, so the run is never hidden.
    assert.deepEqual(readRosterRuns(root, { now: NOW + 60000 }).map((row) => row.engine), ['devin']);

    // The next locked append folds pending lines into the log ahead of its own.
    fs.rmSync(lock);
    appendRosterRun(root, {
      at: new Date(NOW - 3500000).toISOString(), job: 'build', engine: 'cursor', outcome: 'landed', task: 'CLI-2', seconds: 90,
    });
    assert.equal(fs.existsSync(pending), false, 'the pending file is spent');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line) => JSON.parse(line).task), ['CLI-1', 'CLI-2']);
    assert.deepEqual(readRosterRuns(root, { now: NOW + 60000 }).map((row) => row.task), ['CLI-1', 'CLI-2']);

    // A trim can run right after: the pending line is inside the log first,
    // so it survives where the unlocked append used to lose it.
    heldLock(file);
    await appendInWorker(root, {
      at: new Date(NOW - 3400000).toISOString(), job: 'build', engine: 'grok', outcome: 'failed', task: 'CLI-3', seconds: 30,
    }, RUNS_LOCK_WAIT_MS + 8000);
    fs.rmSync(`${file}.lock`);
    const pad = `"${'pad'.repeat(40000)}"\n`;
    fs.appendFileSync(file, pad.repeat(Math.ceil((RUNS_ROTATE_BYTES + 65536) / pad.length)), 'utf8');
    assert.ok(fs.statSync(file).size > RUNS_ROTATE_BYTES);
    appendRosterRun(root, {
      at: new Date(NOW - 3300000).toISOString(), job: 'build', engine: 'claude', outcome: 'landed', task: 'CLI-4', seconds: 45,
    });
    const tasks = readRosterRuns(root, { now: NOW + 60000 }).map((row) => row.task);
    assert.ok(tasks.includes('CLI-3'), 'the pending line survived the trim');
    assert.ok(tasks.includes('CLI-4'), 'the locked line landed too');
  });
});

const WORKER_ROSTER = [
  '# roster',
  '',
  '## build',
  '- devin, model: swe-2-max, max: 20 min, prep: search <!-- keep the handoff -->',
  '- grok, max: 20 min',
  '- claude',
  '',
].join('\n');

function workerLines(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

test('the suggested command promotes the challenger line without rewriting any worker', async () => {
  await withRoom(async ({ root }) => {
    const before = workerLines(root);
    const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
    for (const [index, outcome] of ['stalled', 'stalled', 'stalled'].entries()) {
      appendRosterRun(root, { at: at(300 - index), job: 'build', engine: 'devin', model: 'swe-2-max', outcome, seconds: 1200 });
    }
    for (const [index, outcome] of ['landed', 'landed'].entries()) {
      appendRosterRun(root, { at: at(200 - index), job: 'build', engine: 'grok', outcome, seconds: 600 });
    }
    const report = JSON.parse(command(root, ['roster', '--json']).out);
    const suggestion = report.jobs.find((row) => row.job === 'build').suggestion;
    assert.ok(suggestion, 'a suggestion is offered');
    assert.match(suggestion.command, /^atris engine assign build --promote grok$/);

    // Running the suggested command moves the whole line, notes and all.
    assert.equal(command(root, suggestion.args).exit, 0);
    assert.deepEqual(workerLines(root), [before[1], before[0], before[2]]);

    // --promote matches on tool and model, and says plainly when nothing does.
    assert.equal(command(root, ['assign', 'build', '--promote', 'devin swe-2-max']).exit, 0);
    assert.deepEqual(workerLines(root), before);
    const none = command(root, ['assign', 'build', '--promote', 'cursor']);
    assert.equal(none.exit, 2);
    assert.match(none.err, /has no cursor worker/);
    const mixed = command(root, ['assign', 'build', '--promote', 'grok', '--model', 'x']);
    assert.equal(mixed.exit, 2);
    assert.deepEqual(workerLines(root), before, 'a refused promote writes nothing');
  }, { roster: WORKER_ROSTER, registry: true });
});

function writeDispatchReceipt(root, name, results) {
  const dir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `dispatch-${name}.json`), `${JSON.stringify({
    schema: 'atris.dispatch_receipt.v1',
    results,
  })}\n`, 'utf8');
}

test('a landed dispatch counts once when its receipt and run record share the task', async () => {
  const { loadRouterHistory, rankEnginesDetailed } = require('../lib/router-brain');
  await withRoom(({ root }) => {
    // One dispatch writes both rows: the receipt stamps the moment the run
    // ended, the run record the moment it started. Same engine, same task.
    writeDispatchReceipt(root, 'one', [{
      task: 'CLI-1', engine: 'cursor', task_type: 'executor', verified_passed: true,
      duration_ms: 120000, at: '2026-09-27T11:00:00.000Z', exitCode: 0,
    }]);
    appendRosterRun(root, {
      at: '2026-09-27T10:58:00.000Z', job: 'build', engine: 'cursor', outcome: 'landed',
      task: 'CLI-1', source: 'dispatch', seconds: 120,
    });
    let history = loadRouterHistory(root, { now: NOW });
    assert.equal(history.length, 1, 'the receipt and the run record are one run');
    assert.equal(history[0].verified_passed, true);

    writeDispatchReceipt(root, 'two', [{
      task: 'CLI-2', engine: 'cursor', task_type: 'executor', verified_passed: true,
      duration_ms: 60000, at: '2026-09-27T11:10:00.000Z', exitCode: 0,
    }]);
    appendRosterRun(root, {
      at: '2026-09-27T11:09:00.000Z', job: 'build', engine: 'cursor', outcome: 'landed',
      task: 'CLI-2', source: 'dispatch', seconds: 60,
    });
    history = loadRouterHistory(root, { now: NOW });
    assert.equal(history.length, 2);
    const candidates = [{ id: 'cursor', fallback_order: 30 }, { id: 'codex', fallback_order: 10 }];
    const ranked = rankEnginesDetailed(candidates, { root, taskType: 'executor', now: NOW });
    assert.equal(ranked.used_track_record, false, 'two real runs stay under the three-receipt minimum');

    // A run for another task counts on its own, and so does a much older
    // run for the same task: only the receipt describing it dedupes it.
    appendRosterRun(root, {
      at: '2026-09-27T11:20:00.000Z', job: 'build', engine: 'cursor', outcome: 'failed',
      task: 'CLI-3', source: 'dispatch', seconds: 90,
    });
    appendRosterRun(root, {
      at: '2026-09-26T10:00:00.000Z', job: 'build', engine: 'cursor', outcome: 'landed',
      task: 'CLI-1', source: 'dispatch', seconds: 300,
    });
    history = loadRouterHistory(root, { now: NOW });
    assert.equal(history.length, 4);
  });
});

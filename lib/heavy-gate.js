'use strict';

// Heavy jobs (full test suites, type checks, benchmarks) take turns on this
// machine. A job holds one of a few slots, kept as lock files under
// ~/.atris/heavy so every checkout and every session shares them. A slot
// whose holder has died is freed by the next job that looks at it.
//
// While real free memory is low, a new job waits before it starts. Swap is not
// part of the check: macOS rarely empties swap, so a swap rule would keep the
// gate shut for days. No job waits forever. Past the longest wait it runs
// anyway and says so, so the gate can slow work down but never block it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { readMachineResources } = require('./engine-resource');

const DEFAULT_SLOTS = 2;
const LOW_FREE_PCT = 20;
const POLL_MS = 2000;
const MAX_MEMORY_WAIT_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 30 * 60 * 1000;
// Set inside a gated job, so a heavy job that starts another one does not
// wait on its own slot.
const HELD_ENV = 'ATRIS_HEAVY_HELD';

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function gateSettings(env = process.env) {
  return {
    dir: env.ATRIS_HEAVY_DIR || path.join(os.homedir(), '.atris', 'heavy'),
    slots: positiveInt(env.ATRIS_HEAVY_SLOTS, DEFAULT_SLOTS),
    pollMs: positiveInt(env.ATRIS_HEAVY_POLL_MS, POLL_MS),
    maxMemoryWaitMs: positiveInt(env.ATRIS_HEAVY_MAX_MEMORY_WAIT_MS, MAX_MEMORY_WAIT_MS),
    maxWaitMs: positiveInt(env.ATRIS_HEAVY_MAX_WAIT_MS, MAX_WAIT_MS),
  };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function slotFile(dir, i) {
  return path.join(dir, `slot-${i}.lock`);
}

function readSlot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Who holds each slot right now. Dead holders are cleared on the way.
function listSlots(settings = gateSettings(), deps = {}) {
  const alive = deps.isAlive || isAlive;
  const held = [];
  for (let i = 0; i < settings.slots; i += 1) {
    const file = slotFile(settings.dir, i);
    if (!fs.existsSync(file)) continue;
    const holder = readSlot(file);
    if (holder && alive(holder.pid)) {
      held.push({ slot: i, ...holder });
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  return held;
}

// Takes a free slot and returns its file, or null when every slot is held.
function tryTakeSlot(settings, holder, deps = {}) {
  fs.mkdirSync(settings.dir, { recursive: true });
  listSlots(settings, deps);
  for (let i = 0; i < settings.slots; i += 1) {
    const file = slotFile(settings.dir, i);
    try {
      fs.writeFileSync(file, JSON.stringify(holder), { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  return null;
}

function memoryIsLow(deps = {}) {
  const read = deps.readMachineResources || readMachineResources;
  const { free_pct: free } = read();
  return Number.isFinite(free) && free < LOW_FREE_PCT;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a turn. Resolves to { file, waitedMs, reason }; file is null when
// the job runs without a slot, and reason says why.
async function waitForTurn(holder, settings = gateSettings(), deps = {}) {
  const now = deps.now || Date.now;
  const wait = deps.sleep || sleep;
  const say = deps.log || ((line) => process.stderr.write(`${line}\n`));
  const started = now();
  let told = '';
  for (;;) {
    const waited = now() - started;
    if (waited >= settings.maxWaitMs) {
      return { file: null, waitedMs: waited, reason: 'waited too long, running anyway' };
    }
    const lowMemory = waited < settings.maxMemoryWaitMs && memoryIsLow(deps);
    if (!lowMemory) {
      const file = tryTakeSlot(settings, holder, deps);
      if (file) return { file, waitedMs: waited, reason: '' };
    }
    const why = lowMemory
      ? 'heavy job waiting: memory is low'
      : `heavy job waiting: ${settings.slots} already running`;
    if (why !== told) {
      say(why);
      told = why;
    }
    await wait(settings.pollMs);
  }
}

function releaseSlot(file) {
  if (file) fs.rmSync(file, { force: true });
}

// Runs one command as a heavy job and resolves to its exit code.
async function runHeavy(argv, deps = {}) {
  const env = deps.env || process.env;
  const spawnFn = deps.spawn || spawn;
  const say = deps.log || ((line) => process.stderr.write(`${line}\n`));
  if (!argv.length) throw new Error('nothing to run');
  const childEnv = { ...env, [HELD_ENV]: '1' };

  let turn = { file: null, waitedMs: 0, reason: 'already inside a heavy job' };
  if (env[HELD_ENV] !== '1') {
    const holder = { pid: process.pid, cmd: argv.join(' ').slice(0, 200), cwd: process.cwd(), at: new Date().toISOString() };
    try {
      turn = await waitForTurn(holder, gateSettings(env), deps);
    } catch (err) {
      turn = { file: null, waitedMs: 0, reason: `gate unavailable (${err.message})` };
    }
    if (!turn.file) say(`heavy job: ${turn.reason}`);
  }

  try {
    return await new Promise((resolve) => {
      const child = spawnFn(argv[0], argv.slice(1), { stdio: 'inherit', env: childEnv });
      const forward = (sig) => () => { try { child.kill(sig); } catch {} };
      const onInt = forward('SIGINT');
      const onTerm = forward('SIGTERM');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      const done = (code) => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        resolve(code);
      };
      child.on('error', (err) => { say(`heavy job could not start: ${err.message}`); done(127); });
      child.on('exit', (code, signal) => done(signal ? 128 + (os.constants.signals[signal] || 1) : code ?? 1));
    });
  } finally {
    releaseSlot(turn.file);
  }
}

module.exports = {
  DEFAULT_SLOTS,
  HELD_ENV,
  LOW_FREE_PCT,
  gateSettings,
  listSlots,
  tryTakeSlot,
  waitForTurn,
  releaseSlot,
  runHeavy,
};

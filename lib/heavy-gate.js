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
// A lock older than this is treated as abandoned even when its process id is
// alive, because macOS reuses process ids. A real job past this mark only
// lets one extra job in; it never shuts the gate.
const MAX_HOLD_MS = 3 * 60 * 60 * 1000;
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
    maxHoldMs: positiveInt(env.ATRIS_HEAVY_MAX_HOLD_MS, MAX_HOLD_MS),
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

function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function holderIsLive(holder, settings, deps) {
  const alive = deps.isAlive || isAlive;
  const now = deps.now || Date.now;
  if (!holder || !alive(holder.pid)) return false;
  const at = Date.parse(holder.at);
  return !Number.isFinite(at) || now() - at < (settings.maxHoldMs || MAX_HOLD_MS);
}

// Clears a dead lock only if it still holds what was read, so a job that
// just took the slot is never cleared by one that saw the old holder.
function clearIfUnchanged(file, raw) {
  if (readRaw(file) === raw) fs.rmSync(file, { force: true });
}

// Who holds each slot right now. Dead holders are cleared on the way.
function listSlots(settings = gateSettings(), deps = {}) {
  const held = [];
  for (let i = 0; i < settings.slots; i += 1) {
    const file = slotFile(settings.dir, i);
    const raw = readRaw(file);
    if (raw === null) continue;
    const holder = parse(raw);
    if (holderIsLive(holder, settings, deps)) held.push({ slot: i, ...holder });
    else clearIfUnchanged(file, raw);
  }
  return held;
}

// Takes a free slot and returns its file, or null when every slot is held.
// The lock is written whole under a private name and then linked into place,
// so no job ever reads a half-written lock, and only one link can win.
function tryTakeSlot(settings, holder, deps = {}) {
  fs.mkdirSync(settings.dir, { recursive: true });
  listSlots(settings, deps);
  const body = JSON.stringify({ at: new Date().toISOString(), ...holder, token: `${process.pid}-${Math.random().toString(36).slice(2)}` });
  const draft = path.join(settings.dir, `.draft-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(draft, body);
  try {
    for (let i = 0; i < settings.slots; i += 1) {
      const file = slotFile(settings.dir, i);
      try {
        fs.linkSync(draft, file);
        return { file, body };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    return null;
  } finally {
    fs.rmSync(draft, { force: true });
  }
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
      const slot = tryTakeSlot(settings, holder, deps);
      if (slot) return { file: slot.file, body: slot.body, waitedMs: waited, reason: '' };
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

// Gives the slot back, but only while it still holds this job's own lock.
function releaseSlot(turn) {
  if (turn && turn.file) clearIfUnchanged(turn.file, turn.body);
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
      // Ctrl-C already reaches the child through the terminal, so SIGINT is
      // only held here (the slot is released once the child exits). SIGTERM
      // is sent to this process alone, so it is passed on.
      const onInt = () => {};
      const onTerm = () => { try { child.kill('SIGTERM'); } catch {} };
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
    releaseSlot(turn);
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

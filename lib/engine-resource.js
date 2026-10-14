'use strict';

// How the machine looked when an engine run started and ended: free memory,
// swap, and load, one JSON line per event in .atris/state/engine-resource.jsonl.
// A run killed with SIGKILL leaves no report of its own, so the end line is
// the only evidence for why. Memory fields are read on macOS only; elsewhere
// they stay null rather than a guess.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RESOURCE_LOG = path.join('.atris', 'state', 'engine-resource.jsonl');

// Below this free percent, or above this share of swap in use, a SIGKILL is
// most likely the kernel reclaiming memory.
const LOW_FREE_PCT = 20;
const HIGH_SWAP_SHARE = 0.8;

function defaultRun(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000 });
}

function parseFreePct(text) {
  const match = /memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

function parseSwap(text) {
  const total = /total\s*=\s*(\d+(?:\.\d+)?)M/i.exec(String(text || ''));
  const used = /used\s*=\s*(\d+(?:\.\d+)?)M/i.exec(String(text || ''));
  return {
    swap_used_mb: used ? Number(used[1]) : null,
    swap_total_mb: total ? Number(total[1]) : null,
  };
}

function readOutput(run, cmd, args) {
  try {
    const result = run(cmd, args);
    return result && result.status === 0 ? String(result.stdout || '') : '';
  } catch {
    return '';
  }
}

function readMachineResources(deps = {}) {
  const platform = deps.platform || process.platform;
  const loadavg = deps.loadavg || os.loadavg;
  const load = loadavg().map((n) => Math.round(n * 100) / 100);
  if (platform !== 'darwin') return { free_pct: null, swap_used_mb: null, swap_total_mb: null, load };
  const run = deps.run || defaultRun;
  return {
    free_pct: parseFreePct(readOutput(run, 'memory_pressure', ['-Q'])),
    ...parseSwap(readOutput(run, 'sysctl', ['vm.swapusage'])),
    load,
  };
}

function memoryWasLow(snapshot) {
  if (!snapshot) return false;
  if (Number.isFinite(snapshot.free_pct) && snapshot.free_pct < LOW_FREE_PCT) return true;
  const { swap_used_mb: used, swap_total_mb: total } = snapshot;
  return Number.isFinite(used) && Number.isFinite(total) && total > 0 && used / total >= HIGH_SWAP_SHARE;
}

function killedCauseText(snapshot) {
  return memoryWasLow(snapshot) ? 'killed (machine memory low)' : 'killed (cause unknown)';
}

// Appends one line and returns it. A write failure is swallowed: recording
// the machine's state must never fail the run it describes.
function recordEngineResource(root, { phase, engine, task, signal } = {}, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const entry = {
    at: now(),
    phase: phase || 'start',
    engine: engine || '',
    task: task || '',
    ...readMachineResources(deps),
  };
  if (signal) entry.signal = signal;
  if (signal === 'SIGKILL') entry.cause = killedCauseText(entry);
  try {
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
  return entry;
}

module.exports = {
  RESOURCE_LOG,
  LOW_FREE_PCT,
  HIGH_SWAP_SHARE,
  readMachineResources,
  memoryWasLow,
  killedCauseText,
  recordEngineResource,
};

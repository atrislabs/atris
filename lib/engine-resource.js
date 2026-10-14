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

// Shell startup files that run `eval $(ssh-agent -s)` start a fresh agent for
// every engine shell, and the agent outlives the shell. An agent counts as
// leaked only when it was started in that plain shape, its parent is gone, it
// is older than ten minutes, it belongs to this user, and no live process
// still holds its pid in SSH_AGENT_PID. The macOS system agent runs with -l
// and is never listed.
const LEAK_MIN_AGE_SEC = 600;
const SHELL_AGENT_FLAGS = new Set(['-s', '-c']);

// ps elapsed time: [[dd-]hh:]mm:ss.
function parseElapsed(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text || '').trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function isShellAgent(args) {
  const [program, ...flags] = String(args || '').trim().split(/\s+/);
  return path.basename(program || '') === 'ssh-agent' && flags.every((flag) => SHELL_AGENT_FLAGS.has(flag));
}

function readSshAgents(deps = {}) {
  const run = deps.run || defaultRun;
  const agents = [];
  for (const line of readOutput(run, 'ps', ['-A', '-o', 'pid=,ppid=,uid=,etime=,args=']).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const program = match[5].split(/\s+/)[0];
    if (path.basename(program) !== 'ssh-agent') continue;
    agents.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      age_sec: parseElapsed(match[4]),
      args: match[5],
    });
  }
  const referenced = new Set();
  const authSockets = new Set();
  for (const line of readOutput(run, 'ps', ['-A', '-E', '-o', 'pid=,command=']).split('\n')) {
    const owner = Number((/^\s*(\d+)/.exec(line) || [])[1]);
    for (const ref of line.matchAll(/\bSSH_AGENT_PID=(\d+)/g)) {
      if (Number(ref[1]) !== owner) referenced.add(Number(ref[1]));
    }
    for (const ref of line.matchAll(/\bSSH_AUTH_SOCK=(\S+)/g)) authSockets.add(ref[1]);
  }
  const own = Number(process.env.SSH_AGENT_PID);
  if (Number.isInteger(own) && own > 0) referenced.add(own);
  if (process.env.SSH_AUTH_SOCK) authSockets.add(process.env.SSH_AUTH_SOCK);
  // A shell can reach an agent by its socket alone, so an agent whose socket
  // is named in a live SSH_AUTH_SOCK is in use. An agent whose socket could
  // not be read is treated as in use too.
  const sockets = new Map();
  let socketPid = null;
  for (const line of readOutput(run, 'lsof', ['-a', '-U', '-c', 'ssh-agent', '-F', 'pn']).split('\n')) {
    if (line.startsWith('p')) socketPid = Number(line.slice(1));
    else if (line.startsWith('n/') && socketPid) sockets.set(socketPid, [...(sockets.get(socketPid) || []), line.slice(1)]);
  }
  for (const agent of agents) {
    const own = sockets.get(agent.pid) || [];
    if (!own.length || own.some((socket) => authSockets.has(socket))) referenced.add(agent.pid);
  }
  return { agents, referenced };
}

function findLeakedSshAgents(agents, { referenced = new Set(), uid, minAgeSec = LEAK_MIN_AGE_SEC } = {}) {
  return (agents || []).filter((agent) => agent.ppid === 1
    && agent.uid === uid
    && Number.isFinite(agent.age_sec) && agent.age_sec >= minAgeSec
    && isShellAgent(agent.args)
    && !referenced.has(agent.pid));
}

// Reads the machine again right before stopping anything, so an agent that a
// shell picked up since the list was made, or a pid reused by another agent,
// is skipped. Stops with SIGTERM and writes one sweep line to the resource log.
function stopLeakedSshAgents(root, leaked, { read = readSshAgents, uid, kill = process.kill.bind(process), now = () => new Date().toISOString() } = {}) {
  const recheck = read();
  const still = new Set(findLeakedSshAgents(recheck.agents, { referenced: recheck.referenced, uid }).map((agent) => agent.pid));
  const stopped = [];
  const failed = [];
  const skipped = [];
  for (const { pid } of leaked) {
    if (!still.has(pid)) {
      skipped.push(pid);
      continue;
    }
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch (err) {
      failed.push({ pid, code: (err && err.code) || 'error' });
    }
  }
  try {
    const file = path.join(root, RESOURCE_LOG);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: now(), phase: 'sweep', stopped, failed: failed.map((f) => f.pid), skipped })}\n`);
  } catch {}
  return { stopped, failed, skipped };
}

module.exports = {
  RESOURCE_LOG,
  stopLeakedSshAgents,
  LEAK_MIN_AGE_SEC,
  parseElapsed,
  readSshAgents,
  findLeakedSshAgents,
  LOW_FREE_PCT,
  HIGH_SWAP_SHARE,
  readMachineResources,
  memoryWasLow,
  killedCauseText,
  recordEngineResource,
};

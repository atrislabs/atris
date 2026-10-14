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

// Tests that leave out a root default to the working folder, which is this
// checkout. Under the test runner, never write there, or test runs read back
// later as real engine kills.
const OWN_CHECKOUT = path.resolve(__dirname, '..');

// Keep start, end, and sweep evidence in the main project after a linked
// build folder is removed, using the same lookup as roster run history.
function resourceLogRoot(root) {
  const { mainCheckoutRoot } = require('./engine-registry');
  const main = mainCheckoutRoot(root);
  return main && fs.existsSync(main) ? main : root;
}

function resourceLogFile(root) {
  const project = resourceLogRoot(root);
  if (process.env.NODE_TEST_CONTEXT && (path.resolve(root) === OWN_CHECKOUT
    || path.resolve(project) === path.resolve(resourceLogRoot(OWN_CHECKOUT)))) return null;
  return path.join(project, RESOURCE_LOG);
}

// The log only grows, so once it passes MAX_LOG_BYTES it is cut back to its
// newest KEEP_LOG_BYTES, which covers the tail history reads. An older start
// line stays when its end was not cut with it, so a run still going, or one
// whose end survived, keeps its pair. Starts with no end ever, from runs that
// died with the parent, are capped so they cannot fill the log instead.
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const KEEP_LOG_BYTES = 2 * 1024 * 1024;
const MAX_KEPT_STARTS = 200;

function compactResourceLog(file) {
  if (fs.statSync(file).size <= MAX_LOG_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let cut = lines.length;
  let kept = 0;
  while (cut > 0 && kept + Buffer.byteLength(lines[cut - 1]) + 1 <= KEEP_LOG_BYTES) {
    cut -= 1;
    kept += Buffer.byteLength(lines[cut]) + 1;
  }
  const dropped = lines.slice(0, cut).map((line) => {
    try { return { line, entry: JSON.parse(line) || {} }; } catch { return { line, entry: {} }; }
  });
  const endedHere = new Set(dropped.filter(({ entry }) => entry.phase === 'end' && entry.run_id).map(({ entry }) => entry.run_id));
  const starts = dropped
    .filter(({ entry }) => entry.phase === 'start' && entry.run_id && !endedHere.has(entry.run_id))
    .slice(-MAX_KEPT_STARTS)
    .map(({ line }) => line);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, [...starts, ...lines.slice(cut)].map((line) => `${line}\n`).join(''));
  fs.renameSync(temp, file);
}

// A write failure is swallowed: recording the machine's state must never
// fail the run or sweep it describes.
function appendResourceLine(root, entry) {
  const file = resourceLogFile(root);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { compactResourceLog(file); } catch {}
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {}
}

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

const LOW_MEMORY_CAUSE = 'killed (machine memory low)';
const UNKNOWN_CAUSE = 'killed (cause unknown)';

function killedCauseText(snapshot) {
  return memoryWasLow(snapshot) ? LOW_MEMORY_CAUSE : UNKNOWN_CAUSE;
}

// Appends one line and returns it.
function recordEngineResource(root, { phase, engine, task, run_id, signal, duration_ms } = {}, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const entry = {
    at: now(),
    phase: phase || 'start',
    engine: engine || '',
    task: task || '',
    ...readMachineResources(deps),
  };
  if (run_id) entry.run_id = run_id;
  if (entry.phase === 'end' && Number.isFinite(duration_ms) && duration_ms >= 0) entry.duration_ms = duration_ms;
  if (entry.phase === 'start') {
    entry.leaked_ssh_agents = null;
    try {
      const uid = deps.uid ?? (process.getuid ? process.getuid() : null);
      if (uid !== null) {
        const read = deps.readSshAgents || readSshAgents;
        const { agents, referenced } = read(deps);
        entry.leaked_ssh_agents = findLeakedSshAgents(agents, { referenced, uid }).length;
      }
    } catch {}
  }
  if (signal) entry.signal = signal;
  if (signal === 'SIGKILL') entry.cause = killedCauseText(entry);
  appendResourceLine(root, entry);
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
  const environments = readOutput(run, 'ps', ['-A', '-E', '-o', 'pid=,command=']);
  // Without the environment list nothing can be proven unused.
  if (!environments.trim()) return { agents, referenced: new Set(agents.map((agent) => agent.pid)) };
  for (const line of environments.split('\n')) {
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
  appendResourceLine(root, { at: now(), phase: 'sweep', stopped, failed: failed.map((f) => f.pid), skipped });
  return { stopped, failed, skipped };
}

// The newest sweep and SIGKILL from the resource log, plus how many SIGKILLs
// were blamed on low memory. Reads only the last megabyte, so a long log
// stays cheap; a line that does not parse is skipped.
const HISTORY_TAIL_BYTES = 1024 * 1024;

function readResourceHistory(root) {
  const history = { last_sweep: null, last_kill: null, kills: 0, low_memory_kills: 0 };
  let text = '';
  try {
    const file = path.join(resourceLogRoot(root), RESOURCE_LOG);
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - HISTORY_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return history;
  }
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.phase === 'sweep') history.last_sweep = entry;
    if (entry.phase === 'end' && entry.signal === 'SIGKILL') {
      history.last_kill = entry;
      history.kills += 1;
      if (entry.cause === LOW_MEMORY_CAUSE) history.low_memory_kills += 1;
    }
  }
  return history;
}

module.exports = {
  RESOURCE_LOG,
  MAX_LOG_BYTES,
  readResourceHistory,
  stopLeakedSshAgents,
  LEAK_MIN_AGE_SEC,
  parseElapsed,
  readSshAgents,
  findLeakedSshAgents,
  readMachineResources,
  memoryWasLow,
  killedCauseText,
  recordEngineResource,
};

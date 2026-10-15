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

// Full paths, so a run launched from cron or launchd with a narrow PATH still
// reads swap and agent sockets. A tool missing from its usual folder falls
// back to the PATH lookup.
const SYSTEM_TOOLS = {
  memory_pressure: '/usr/bin/memory_pressure',
  sysctl: '/usr/sbin/sysctl',
  ps: '/bin/ps',
  lsof: '/usr/sbin/lsof',
};

function defaultRun(cmd, args) {
  const full = SYSTEM_TOOLS[cmd];
  return spawnSync(full && fs.existsSync(full) ? full : cmd, args, { encoding: 'utf8', timeout: 3000 });
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
// The dispatch sent this kill itself when the run passed its time limit, so
// the cause is known and memory readings do not change it.
const TIME_LIMIT_CAUSE = 'killed (time limit reached)';

function killedCauseText(snapshot) {
  return memoryWasLow(snapshot) ? LOW_MEMORY_CAUSE : UNKNOWN_CAUSE;
}

// The one minute load beside this machine's core count, so a run that hit
// its time limit on a crowded machine reads apart from one that was slow on
// its own. Empty when the reading has no load.
function machineCores() {
  return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
}

function killLoadText(entry, cores = machineCores()) {
  const load = entry && Array.isArray(entry.load) ? entry.load[0] : null;
  if (!Number.isFinite(load)) return '';
  const busiest = Array.isArray(entry.busiest) ? entry.busiest.filter((p) => p && p.name && Number.isFinite(p.cpu)) : [];
  const names = busiest.length ? `, busiest ${busiest.map((p) => `${p.name} ${p.cpu}%`).join(', ')}` : '';
  return `, load ${load} on ${cores} cores${names}`;
}

// The programs using the most CPU from one process list, summed by program
// name so many helpers of one app read as that app. Empty when the list
// could not be read.
function parseBusiest(text, limit = 3) {
  const totals = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const cpu = Number(match[1]);
    const name = path.basename(match[2]);
    if (cpu > 0 && name) totals.set(name, (totals.get(name) || 0) + cpu);
  }
  return [...totals.entries()]
    .map(([name, cpu]) => ({ name, cpu: Math.round(cpu) }))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

// Appends one line and returns it.
function recordEngineResource(root, { phase, engine, task, run_id, signal, duration_ms, timed_out, error } = {}, deps = {}) {
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
    // The process that will write the end line; if it is gone and no end
    // came, the run was lost with it. A short helper writing for a longer
    // caller, like a shell script, passes the caller's pid.
    entry.pid = Number.isInteger(deps.pid) && deps.pid > 0 ? deps.pid : process.pid;
    entry.leaked_ssh_agents = null;
    try {
      const uid = deps.uid ?? (process.getuid ? process.getuid() : null);
      if (uid !== null) {
        const read = deps.readSshAgents || readSshAgents;
        const { agents, referenced, unread = [] } = read(deps);
        // A partial scan cannot establish a count, even when no agents were found.
        if (!unread.length) entry.leaked_ssh_agents = findLeakedSshAgents(agents, { referenced, uid }).length;
      }
    } catch {}
  }
  if (signal) entry.signal = signal;
  if (entry.phase === 'end' && timed_out === true) entry.timed_out = true;
  if (entry.phase === 'end' && typeof error === 'string' && error) entry.error = error;
  if (signal === 'SIGKILL') entry.cause = entry.timed_out ? TIME_LIMIT_CAUSE : killedCauseText(entry);
  // A kill on a machine with more work than cores names what was using the
  // CPU, so a crowd from outside the engine runs has a name.
  const cores = Number.isInteger(deps.cores) && deps.cores > 0 ? deps.cores : machineCores();
  if (signal === 'SIGKILL' && entry.load[0] > cores) {
    const busiest = parseBusiest(readOutput(deps.run || defaultRun, 'ps', ['-Ao', 'pcpu=,comm=']));
    if (busiest.length) entry.busiest = busiest;
  }
  appendResourceLine(root, entry);
  return entry;
}

// Start and end readings around one engine launch that reports failure by
// throwing, like the autopilot and run phases. The returned end takes the
// thrown error, or nothing on success, writes once, and returns its line.
function startEngineRun(root, { engine, task } = {}, deps = {}) {
  const resource = { engine: engine || 'runner', task: task || '', run_id: require('crypto').randomUUID() };
  recordEngineResource(root, { phase: 'start', ...resource }, deps);
  const startedAt = process.hrtime.bigint();
  let ended = null;
  return (err = null) => {
    if (ended) return ended;
    const timedOut = Boolean(err && err.code === 'ETIMEDOUT');
    const signal = err && err.signal ? err.signal : null;
    const stderr = err ? String(err.stderr || '') : '';
    const error = err && !signal && !timedOut ? (stderr.trim() ? stderr : String(err.message || '')).slice(-2000) : '';
    ended = recordEngineResource(root, { phase: 'end', ...resource, signal, timed_out: timedOut, error, duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6) }, deps);
    return ended;
  };
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
  let processes;
  try { processes = run('ps', ['-A', '-o', 'pid=,ppid=,uid=,etime=,args=']); } catch {}
  if (!processes || processes.status !== 0) return { agents, referenced: new Set(), unread: ['process list'] };
  for (const line of String(processes.stdout || '').split('\n')) {
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
  // Without the environment list nothing can be proven unused. unread names
  // each reader that failed, so the sweep can say an empty list is not clean.
  if (!environments.trim()) return { agents, referenced: new Set(agents.map((agent) => agent.pid)), unread: ['process environments'] };
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
  // With no agents running, lsof finding no sockets is the right answer.
  return { agents, referenced, unread: agents.some((agent) => !(sockets.get(agent.pid) || []).length) ? ['agent sockets'] : [] };
}

// Shell startup files that run an ssh-agent start a new one in every shell
// that reads them, which is how agents pile up under engine shells. Names
// each uncommented line that runs ssh-agent through eval or command
// substitution, unless the same line checks for a running agent; a guard on
// an earlier line is not seen, so this is a lead. A line that is only an eval
// gets a fix that starts an agent only when no agent socket is reachable.
const SHELL_STARTUP_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.bashrc', '.profile'];
const AGENT_GUARD = '[ -S "$SSH_AUTH_SOCK" ] || ';

function findAgentStartLines({ home = os.homedir() } = {}) {
  const found = [];
  for (const name of SHELL_STARTUP_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(home, name), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, '').trim();
      if (!/\bssh-agent\b/.test(code) || !/\beval\b|\$\(|`/.test(code)) return;
      if (/\bSSH_(AUTH_SOCK|AGENT_PID)\b/.test(code)) return;
      const lone = /^eval\s/.test(code) && !/[;&|]|\b(if|then|fi)\b/.test(code);
      found.push({ file: `~/${name}`, line: i + 1, ...(lone ? { fix: `${AGENT_GUARD}${code}` } : {}) });
    });
  }
  return found;
}

// One plain line per startup line found, shared by the sweep and the
// landing status so both name the source and its fix the same way. In each
// session that runs a command, Claude and Codex start a login zsh that reads
// ~/.zshenv, ~/.zprofile, and ~/.zlogin and also sources ~/.zshrc by path
// (Claude picks ~/.bashrc for a bash shell), so a line in these files starts
// another agent per engine session. Receipt:
// atris/receipts/engine-shell-startup-proof-2026-10-14.txt
const ENGINE_STARTUP_FILES = new Set(['~/.zshenv', '~/.zprofile', '~/.zshrc', '~/.zlogin', '~/.bashrc']);

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return ''; }
}

// The real file of the first executable command on PATH, or '' when absent.
function findPathExecutable(name, pathEnv = process.env.PATH) {
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      const found = realPath(candidate);
      if (found) return found;
    } catch { /* Keep looking when this entry cannot run. */ }
  }
  return '';
}

function findPathAtris(pathEnv = process.env.PATH) {
  return findPathExecutable('atris', pathEnv);
}

// Only an atris that has this file writes engine run lines, so the runs an
// older atris on PATH starts leave none, and agents they leak read as
// started with no engine run open. True when there is no atris on PATH.
function pathAtrisRecordsRuns({ pathEnv = process.env.PATH } = {}) {
  const found = findPathAtris(pathEnv);
  return !found || fs.existsSync(path.join(path.dirname(path.dirname(found)), 'lib', 'engine-resource.js'));
}

// The atris on PATH can be an older install that has no sweep, so a command
// printed for the person names this checkout by path unless the atris on
// PATH runs from this same bin folder.
function atrisCommand({ pathEnv = process.env.PATH, binDir = path.join(__dirname, '..', 'bin'), home = os.homedir() } = {}) {
  const real = realPath;
  const self = real(binDir);
  if (!self) return 'atris';
  const found = findPathAtris(pathEnv);
  const script = path.join(self, 'atris.js');
  const node = found && path.dirname(found) === self ? findPathExecutable('node', pathEnv) : '';
  if (node) {
    const probe = spawnSync(node, [script, 'version'], {
      env: { ...process.env, PATH: pathEnv }, encoding: 'utf8', timeout: 2000,
    });
    if (!probe.error && probe.status === 0 && /^atris v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(probe.stdout.trim())) return 'atris';
  }
  const shown = home && script.startsWith(`${real(home) || home}${path.sep}`) ? `~${script.slice((real(home) || home).length)}` : script;
  const runtime = /[^a-zA-Z0-9_./:-]/.test(process.execPath) ? `'${process.execPath.replace(/'/g, "'\\''")}'` : process.execPath;
  return /[^a-zA-Z0-9_./~:-]/.test(shown) ? `${runtime} '${script.replace(/'/g, "'\\''")}'` : `${runtime} ${shown}`;
}

// Printed under the startup lines when at least one has a fix, so the sweep
// and the landing status point to the same one-step change.
function fixStartupHint(cli = atrisCommand()) {
  return `to make that change, run ${cli} engine sweep --fix-startup; it saves the old file beside it first`;
}

function agentStartLineText({ file, line, fix }) {
  const engines = ENGINE_STARTUP_FILES.has(file) ? ', including the shells Claude and Codex start in each session that runs a command' : '';
  return `likely source: ${file} line ${line} starts a new ssh-agent in every shell that reads it${engines}${fix ? `; to start one only when none is reachable, change it to: ${fix}` : ''}`;
}

// Rewrites each lone unguarded agent start to the guarded line the sweep
// prints, after copying the file beside itself. A file is written only when
// every line to change still holds the command that was found; a line that
// does more than start an agent is left for a hand edit. These files belong
// to the person, so only an explicit request runs this.
function fixAgentStartLines({ home = os.homedir(), now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const changed = [];
  const left = [];
  const failed = [];
  const byFile = new Map();
  for (const found of findAgentStartLines({ home })) {
    if (!found.fix) left.push(found);
    else byFile.set(found.file, [...(byFile.get(found.file) || []), found]);
  }
  for (const [file, lines] of byFile) {
    const full = path.join(home, file.slice(2));
    try {
      const rows = fs.readFileSync(full, 'utf8').split('\n');
      for (const found of lines) {
        const row = rows[found.line - 1] || '';
        const command = found.fix.slice(AGENT_GUARD.length);
        const at = row.indexOf(command);
        if (at < 0) throw new Error(`line ${found.line} changed after it was read`);
        rows[found.line - 1] = row.slice(0, at) + found.fix + row.slice(at + command.length);
      }
      const backup = `${file}.atris-${stamp}.bak`;
      fs.copyFileSync(full, path.join(home, backup.slice(2)), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(full, rows.join('\n'));
      changed.push(...lines.map((found) => ({ ...found, backup })));
    } catch (err) {
      failed.push(...lines.map((found) => ({ ...found, error: String((err && err.message) || err).slice(0, 200) })));
    }
  }
  return { changed, left, failed };
}

function findLeakedSshAgents(agents, { referenced = new Set(), uid, minAgeSec = LEAK_MIN_AGE_SEC } = {}) {
  return (agents || []).filter((agent) => agent.ppid === 1
    && agent.uid === uid
    && Number.isFinite(agent.age_sec) && agent.age_sec >= minAgeSec
    && isShellAgent(agent.args)
    && !referenced.has(agent.pid));
}

// Reads the machine again right before stopping anything, so an agent that a
// shell picked up since the list was made, or a pid reused by a younger agent,
// is skipped. Stops with SIGTERM, oldest first, at most limit agents, and
// writes one sweep line to the resource log. Agents still leaked past the
// limit are kept as deferred so the next sweep can take them. When the
// caller read the shell startup files, the line also counts the unguarded
// agent starts found, so a later reading can tell when the source was fixed.
function stopLeakedSshAgents(root, leaked, { read = readSshAgents, uid, kill = process.kill.bind(process), now = () => new Date().toISOString(), limit = Infinity, startLines } = {}) {
  const recheck = read();
  const unread = recheck.unread || [];
  const current = new Map(recheck.agents.map((agent) => [agent.pid, agent]));
  const still = new Map(findLeakedSshAgents(recheck.agents, { referenced: recheck.referenced, uid }).map((agent) => [agent.pid, agent]));
  const stopped = [];
  const failed = [];
  const skipped = [];
  const replaced = [];
  const deferred = [];
  for (const { pid, age_sec } of [...leaked].sort((a, b) => b.age_sec - a.age_sec)) {
    if (!still.has(pid) || still.get(pid).age_sec < age_sec) {
      skipped.push(pid);
      if (current.has(pid) && current.get(pid).age_sec < age_sec) replaced.push(pid);
      continue;
    }
    if (stopped.length + failed.length >= limit) {
      deferred.push(pid);
      continue;
    }
    try {
      kill(pid, 'SIGTERM');
      stopped.push(pid);
    } catch (err) {
      failed.push({ pid, code: (err && err.code) || 'error' });
    }
  }
  // How many still looked leaked once this sweep was done, so the growth
  // note can count from here instead of from the pile it just cleared.
  const left = unread.length ? null : Math.max(0, still.size - stopped.length);
  const extra = { ...(replaced.length ? { replaced } : {}), ...(deferred.length ? { deferred } : {}) };
  const source = Array.isArray(startLines) ? { unguarded_start_lines: startLines.length } : {};
  appendResourceLine(root, { at: now(), phase: 'sweep', stopped, failed: failed.map((f) => f.pid), skipped, ...extra, leaked_ssh_agents: left, ...source, ...(unread.length ? { unread } : {}) });
  return { stopped, failed, skipped, ...extra, ...(left === null ? {} : { left }), ...(unread.length ? { unread } : {}) };
}

// The newest sweep and SIGKILL from the resource log, how many SIGKILLs were
// blamed on low memory, the runs whose start has no matching end, and the
// runs closed after their parent died, and the newest run that failed with
// a message without being killed. Kills and closes are also counted for
// the last day, with time limit kills apart and the newest other kill kept so
// a run of timeouts cannot hide a crash. Reads
// up to the size cap, which covers the whole log once it has been cut back,
// so an unfinished start kept at the top is still seen; only a log that grew
// past the cap before the cap existed is read from its tail until the next
// append cuts it. A line that does not parse is skipped, and starts from
// before run ids existed are not counted.
const HISTORY_TAIL_BYTES = MAX_LOG_BYTES;
const DAY_MS = 24 * 3600 * 1000;

// A pid owned by another user still answers with EPERM. A reused pid reads
// as alive, so a lost run can be undercounted but never invented.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function scanResourceLog(root, { now = Date.now(), cores = machineCores() } = {}) {
  const dayAgo = now - DAY_MS;
  const history = { last_sweep: null, last_kill: null, kills: 0, low_memory_kills: 0, time_limit_kills: 0, last_other_kill: null, kills_day: 0, low_memory_kills_day: 0, time_limit_kills_day: 0, crowded_time_limit_kills_day: 0, crowded_peak_open_runs: 0, crowded_top_busiest: null, last_day_other_kill: null, open_runs: 0, parent_gone: 0, still_running: 0, last_open: null, lost_closed: 0, lost_closed_day: 0, last_lost_closed: null, first_day_leak_reading: null, start_lines_guarded: null, last_error: null, errors_day: 0, last_day_error: null, read_error: null };
  const open = new Map();
  let lastStartCount = null;
  const leakReadings = [];
  // How often each program used the most CPU at a crowded kill in the day.
  const topBusiest = new Map();
  // Every run with a start time, ended or not, so leaked ssh-agents can be
  // matched to the runs open when they started.
  const runs = new Map();
  let logFrom = null;
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
  } catch (err) {
    // No log yet means no runs; any other failure means the runs are unknown.
    const readError = err && err.code !== 'ENOENT' ? String(err.code || err.message || err) : null;
    return { history, open, runs: [], logFrom, readError };
  }
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    const atMs = Date.parse(entry.at);
    if (logFrom === null && Number.isFinite(atMs)) logFrom = atMs;
    if (entry.phase === 'start' && entry.run_id && Number.isFinite(atMs)) runs.set(entry.run_id, { engine: entry.engine || 'unknown engine', from: atMs, to: null });
    if (entry.phase === 'end' && runs.has(entry.run_id) && Number.isFinite(atMs)) runs.get(entry.run_id).to = atMs;
    if (entry.phase === 'sweep') history.last_sweep = entry;
    // The sweep that first found no unguarded agent start in the shell
    // startup files after one that found some, so the status can say when
    // the leak source was fixed; a later count above zero clears it.
    if (entry.phase === 'sweep' && Number.isFinite(entry.unguarded_start_lines)) {
      if (entry.unguarded_start_lines > 0) history.start_lines_guarded = null;
      else if (lastStartCount && lastStartCount.unguarded_start_lines > 0) history.start_lines_guarded = { at: entry.at, before_at: lastStartCount.at, before: lastStartCount.unguarded_start_lines };
      lastStartCount = entry;
    }
    if (entry.phase === 'start' && entry.run_id) open.set(entry.run_id, entry);
    if (Number.isFinite(entry.leaked_ssh_agents) && Number.isFinite(Date.parse(entry.at))) leakReadings.push({ ms: Date.parse(entry.at), count: entry.leaked_ssh_agents });
    // The oldest leaked ssh-agent count a run start recorded in the last day,
    // so the status can say how fast the pile is growing. A sweep that
    // stopped agents starts the count over from what it left.
    if (Number.isFinite(entry.leaked_ssh_agents) && Date.parse(entry.at) >= dayAgo) {
      const cleared = entry.phase === 'sweep' && Array.isArray(entry.stopped) && entry.stopped.length > 0;
      if (cleared || (entry.phase === 'start' && !history.first_day_leak_reading)) history.first_day_leak_reading = entry;
    }
    // Runs open as this one ends, itself included when its start was logged.
    const openAtEnd = open.size;
    if (entry.phase === 'end' && entry.run_id) open.delete(entry.run_id);
    if (entry.phase === 'end' && entry.cause === PARENT_GONE_CAUSE) {
      history.last_lost_closed = entry;
      history.lost_closed += 1;
      if (Date.parse(entry.at) >= dayAgo) history.lost_closed_day += 1;
    }
    // The newest run that failed with a message but was not killed, such as
    // an engine that could not start; kills are named on their own.
    if (entry.phase === 'end' && !entry.signal && typeof entry.error === 'string' && entry.error.trim()) {
      history.last_error = entry;
      if (Date.parse(entry.at) >= dayAgo) {
        history.errors_day += 1;
        history.last_day_error = entry;
      }
    }
    if (entry.phase === 'end' && entry.signal === 'SIGKILL') {
      history.last_kill = entry;
      history.kills += 1;
      if (entry.cause === LOW_MEMORY_CAUSE) history.low_memory_kills += 1;
      if (entry.cause === TIME_LIMIT_CAUSE) history.time_limit_kills += 1;
      else history.last_other_kill = entry;
      if (Date.parse(entry.at) >= dayAgo) {
        history.kills_day += 1;
        if (entry.cause === LOW_MEMORY_CAUSE) history.low_memory_kills_day += 1;
        if (entry.cause === TIME_LIMIT_CAUSE) {
          history.time_limit_kills_day += 1;
          // A run that ran out of time while the machine had more work than
          // cores was likely slowed by the crowd, not by its own task.
          if (Array.isArray(entry.load) && entry.load[0] > cores) {
            history.crowded_time_limit_kills_day += 1;
            history.crowded_peak_open_runs = Math.max(history.crowded_peak_open_runs, openAtEnd);
            const top = Array.isArray(entry.busiest) && entry.busiest[0] && entry.busiest[0].name;
            if (top) topBusiest.set(top, (topBusiest.get(top) || 0) + 1);
          }
        } else history.last_day_other_kill = entry;
      }
    }
  }
  // The program that used the most CPU at the most crowded kills; the first
  // to reach the count wins a tie.
  for (const [name, kills] of topBusiest) {
    if (!history.crowded_top_busiest || kills > history.crowded_top_busiest.kills) history.crowded_top_busiest = { name, kills };
  }
  const guarded = history.start_lines_guarded;
  if (guarded) {
    const at = Date.parse(guarded.at);
    guarded.rate_before = newLeakRate(leakReadings, at - DAY_MS, at);
    guarded.rate_since = newLeakRate(leakReadings, at, now);
  }
  return { history, open, runs: [...runs.values()], logFrom };
}

// Splits leaked ssh-agents by what was running when each started: an engine
// run from the run log that had started and not yet ended, no run at all, or
// a time before the log begins, where nothing can be said. A run with no end
// counts as open until now. Agents that start during a run are not proven to
// come from it, so this names where to look, not the cause. The last hour is
// counted again on its own, since the whole count can hide a change.
function matchLeakedToRuns(root, leaked, { now = Date.now() } = {}) {
  const { runs, logFrom, readError } = scanResourceLog(root, { now });
  const result = { during: {}, during_total: 0, outside: 0, before_log: 0, recent: { during: 0, outside: 0 } };
  const hourAgo = now - 3600000;
  if (readError) return { ...result, read_error: readError };
  for (const agent of leaked || []) {
    const started = now - agent.age_sec * 1000;
    if (logFrom === null || started < logFrom) {
      result.before_log += 1;
      continue;
    }
    const run = runs.filter((r) => r.from <= started && (r.to === null ? now : r.to) >= started).sort((a, b) => b.from - a.from)[0];
    if (started >= hourAgo) result.recent[run ? 'during' : 'outside'] += 1;
    if (!run) {
      result.outside += 1;
      continue;
    }
    result.during[run.engine] = (result.during[run.engine] || 0) + 1;
    result.during_total += 1;
  }
  return result;
}

// One plain line for the landing status and the sweep, or '' when no leaked
// agent started inside the time the run log covers. When most started with
// no engine run open and a startup line was found, it says that line is the
// one to fix, unless most of the last hour started during engine runs; the
// caller prints the line right after.
function leakedRunsText(match, { startLine = false, recorded = true } = {}) {
  if (!match || match.read_error) return '';
  if (!match.during_total && !match.outside) return '';
  const engines = Object.entries(match.during).sort((a, b) => b[1] - a[1]).map(([engine, n]) => `${engine} ${n}`).join(', ');
  const parts = [`${match.during_total} started while an engine run was open${engines ? ` (${engines})` : ''}`, `${match.outside} with no engine run open`];
  if (match.before_log) parts.push(`${match.before_log} before the run log begins`);
  const recent = match.recent || { during: 0, outside: 0 };
  const lastHour = recent.during + recent.outside ? `; in the last hour: ${recent.during} while an engine run was open, ${recent.outside} with none open` : '';
  const unrecorded = recorded ? '' : '; the atris on your PATH does not record engine runs, so agents from the runs it starts count as none open';
  const outsideMost = recorded && startLine && match.outside > match.during_total && recent.during <= recent.outside;
  return `when the leaked ssh-agents started: ${parts.join(', ')}${lastHour}${unrecorded}${outsideMost ? '; most started with no engine run open, so the startup line below is the one to fix, not an engine' : ''}`;
}

// New leaked ssh-agents an hour between two times: each rise from one
// reading to the next is new leaks, and a fall is a sweep or a reboot, so
// it adds nothing. Null with fewer than two readings or under 15 minutes
// between the first and the last, where an hourly rate would be a guess.
function newLeakRate(readings, from, to) {
  const inside = readings.filter((r) => r.ms >= from && r.ms <= to);
  if (inside.length < 2) return null;
  const hours = (inside[inside.length - 1].ms - inside[0].ms) / 3600000;
  if (hours < 0.25) return null;
  let added = 0;
  for (let i = 1; i < inside.length; i += 1) added += Math.max(0, inside[i].count - inside[i - 1].count);
  return Math.round(added / hours);
}

const PARENT_GONE_CAUSE = 'parent gone';

function parentGone(entry) {
  return Number.isInteger(entry.pid) && entry.pid > 0 && !processAlive(entry.pid);
}

// The first line of a run's error, short enough for one status line.
function errorReason(entry) {
  const text = entry && typeof entry.error === 'string' ? entry.error : '';
  return (text.split('\n').map((line) => line.trim()).find(Boolean) || '').slice(0, 200);
}

function readResourceHistory(root, { now, cores } = {}) {
  const { history, open, readError } = scanResourceLog(root, { ...(now === undefined ? {} : { now }), ...(cores === undefined ? {} : { cores }) });
  // An empty history from a log that could not be read is not a quiet one.
  if (readError) history.read_error = readError;
  history.open_runs = open.size;
  for (const entry of open.values()) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
    if (parentGone(entry)) history.parent_gone += 1;
    else history.still_running += 1;
  }
  history.last_open = [...open.values()].pop() || null;
  return history;
}

// Growth since the oldest count a run start recorded in the last day, or
// since the newest sweep that stopped agents; quiet when the pile has not
// grown, so only a filling machine reads as urgent.
// The landing status and the sweep both print it.
function leakGrowthNote(reading, now, at = Date.now()) {
  if (!reading || !(now > reading.leaked_ssh_agents)) return '';
  const when = `${String(reading.at || '').slice(0, 16).replace('T', ' ')} UTC`;
  const hours = (at - Date.parse(reading.at)) / 3600000;
  const rate = hours >= 0.25 ? `, about ${Math.round((now - reading.leaked_ssh_agents) / hours)} more an hour` : '';
  const from = reading.phase === 'sweep' ? `${reading.leaked_ssh_agents} left by the sweep` : reading.leaked_ssh_agents;
  return `, up from ${from} at ${when}${rate}`;
}

// Writes an end line for each unfinished run whose parent process is gone,
// so the log stops carrying it as open. The line has no machine readings:
// they would describe the sweep, not the moment the run was lost.
function closeLostRuns(root, { now = () => new Date().toISOString() } = {}) {
  const closed = [];
  const { open, readError } = scanResourceLog(root);
  if (readError) throw new Error(`could not read the engine run log: ${readError}`);
  for (const entry of open.values()) {
    if (!parentGone(entry)) continue;
    const end = { at: now(), phase: 'end', engine: entry.engine || '', task: entry.task || '', run_id: entry.run_id, cause: PARENT_GONE_CAUSE, closed_by: 'sweep' };
    appendResourceLine(root, end);
    closed.push(end);
  }
  return closed;
}

module.exports = {
  killLoadText,
  parseBusiest,
  machineCores,
  RESOURCE_LOG,
  MAX_LOG_BYTES,
  readResourceHistory,
  errorReason,
  leakGrowthNote,
  matchLeakedToRuns,
  leakedRunsText,
  closeLostRuns,
  stopLeakedSshAgents,
  LEAK_MIN_AGE_SEC,
  parseElapsed,
  readSshAgents,
  findLeakedSshAgents,
  findAgentStartLines,
  fixAgentStartLines,
  agentStartLineText,
  atrisCommand,
  pathAtrisRecordsRuns,
  fixStartupHint,
  readMachineResources,
  memoryWasLow,
  killedCauseText,
  recordEngineResource,
  startEngineRun,
};

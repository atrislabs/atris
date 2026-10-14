'use strict';

// One screen of every member with a progress log: what job it is on, its last
// step, how long ago that was, and whether it is working, quiet, or done.
// Reads the logs lib/member-progress.js writes: "<iso> <mission> <text>".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUN_TAG, runMarker } = require('./member-progress');

const QUIET_AFTER_MS = 2 * 60 * 1000;
const HIDE_DONE_AFTER_MS = 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const JOB_WIDTH = 50;
const STEP_WIDTH = 50;

function progressDir() {
  return process.env.ATRIS_PROGRESS_DIR || path.join(os.homedir(), '.atris', 'progress');
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A cut read starts mid-line; drop the partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseLine(raw) {
  const m = /^(\S+) (\S+) (.*)$/.exec(raw);
  if (!m) return null;
  const at = Date.parse(m[1]);
  if (Number.isNaN(at)) return null;
  return { at, mission: m[2], text: m[3] };
}

// "started: [pid 4242 engine claude] job" -> { pid, engine, job }. Older
// lines have no tag, so pid stays null and the board cannot say if it lives.
function parseStarted(text) {
  const body = String(text || '').replace(/^started:\s*/, '');
  const m = RUN_TAG.exec(body);
  if (!m) return { pid: null, engine: '', run: '', job: body };
  return { pid: Number(m[1]), engine: m[2] || '', run: m[3] || '', job: body.slice(m[0].length) };
}

// Signal 0 checks a process exists without touching it. EPERM means it
// exists but belongs to someone else, which still counts as alive.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function cut(text, width) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 3)}...` : s;
}

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function ago(ms) {
  return `${span(ms)} ago`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The current run is everything from the latest "started:" line on.
// Steps that only write the member's own log are housekeeping, so the last
// step column skips them unless nothing else happened.
function currentRun(text) {
  const lines = text.split('\n').map(parseLine).filter(Boolean);
  if (!lines.length) return null;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.startsWith('started:')) { start = i; break; }
  }
  const run = lines.slice(start);
  const startedLine = run[0].text.startsWith('started:') ? run[0] : null;
  const finished = [...run].reverse().find((l) => l.text.startsWith('finished:'));
  // A stop wins over the runner's own "finished: failed" that may land first.
  const stopped = run.some((l) => /^finished:\s*stopped\b/.test(l.text));
  return { run, startedLine, finished, stopped, meta: parseStarted(startedLine ? startedLine.text : '') };
}

function memberRow(name, text, now) {
  const current = currentRun(text);
  if (!current) return null;
  const { run, startedLine, finished, stopped, meta } = current;
  const ownLog = new RegExp(`atris/team/${escapeRe(name)}/logs\\b`);
  const steps = run.filter((l) => !l.text.startsWith('started:') && !l.text.startsWith('finished:'));
  const real = steps.filter((l) => !ownLog.test(l.text));
  const step = real[real.length - 1] || steps[steps.length - 1];
  const last = run[run.length - 1];
  const alive = finished || meta.pid === null ? null : isAlive(meta.pid);
  let state;
  if (stopped) state = 'stopped';
  else if (finished) state = /^finished:\s*ok\b/.test(finished.text) ? 'done ok' : 'done failed';
  else if (alive === false) state = 'stopped';
  else state = now - last.at < QUIET_AFTER_MS ? 'working' : 'quiet';
  return {
    member: name,
    state,
    pid: meta.pid,
    engine: meta.engine,
    // null when the started line has no pid; false once the run is over.
    alive: meta.pid === null ? null : alive === true,
    running_for: alive ? span(now - startedLine.at) : '',
    job: startedLine ? cut(meta.job, JOB_WIDTH) : '',
    step: step ? cut(step.text, STEP_WIDTH) : '',
    ago: ago(now - last.at),
    at: last.at,
    // Finished more than an hour ago: off the board unless --all.
    idle: last.text.startsWith('finished:') && now - last.at >= HIDE_DONE_AFTER_MS,
  };
}

function readBoard({ dir = progressDir(), now = Date.now(), all = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch {}
  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = readTail(path.join(dir, f)); } catch { continue; }
    const row = memberRow(f.slice(0, -'.log'.length), text, now);
    if (row) rows.push(row);
  }
  return rows.filter((r) => all || !r.idle).sort((a, b) => b.at - a.at);
}

function renderBoard(rows, dir = progressDir(), hidden = 0) {
  const note = hidden ? `${hidden} finished over an hour ago, hidden. --all shows them` : '';
  if (!rows.length) return note ? `nobody is working right now. ${note}` : `no member progress yet in ${dir}`;
  const cells = rows.map((r) => [
    r.member,
    r.state,
    r.alive === null ? '-' : (r.alive ? 'yes' : 'no'),
    r.engine || '-',
    r.running_for || '-',
    r.ago,
    r.job || '-',
    r.step || '-',
  ]);
  const head = ['member', 'state', 'alive', 'engine', 'running for', 'ago', 'job', 'last step'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [line(head)];
  for (const c of cells) out.push(line(c));
  if (note) out.push('', note);
  return out.join('\n');
}

// Live stream format for `atris member board --json --follow`, one JSON
// object per line on stdout, forever:
//   first line: {"kind":"snapshot","at":"<iso>","dir":"<progress dir>","members":[<same rows as --json>]}
//   then one line per new progress line, in the order it was read:
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"started","text":"<job>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"step","text":"<step>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"finished","text":"ok","ok":true}
// "ok" appears only on finished. Lines that are not "<iso> <mission> <text>"
// are skipped, and a line is only read once its newline has been written.
// Stops on ctrl-c, or on the next write after the reader closes the pipe;
// an app that is done should kill the process.
function progressEvent(member, raw) {
  const m = /^(\S+) (\S+) (.*)$/.exec(raw);
  if (!m) return null;
  const at = Date.parse(m[1]);
  if (Number.isNaN(at)) return null;
  const event = { member, mission: m[2], at: new Date(at).toISOString(), kind: 'step', text: m[3] };
  const tagged = /^(started|finished):\s*(.*)$/.exec(m[3]);
  if (tagged) {
    event.kind = tagged[1];
    event.text = tagged[2];
    if (tagged[1] === 'started') {
      const meta = parseStarted(tagged[2]);
      event.text = meta.job;
      if (meta.pid !== null) { event.pid = meta.pid; event.engine = meta.engine; }
    }
    if (tagged[1] === 'finished') event.ok = /^ok\b/.test(tagged[2]);
  }
  return event;
}

// Tails every <member>.log in dir and calls emit(event) for each new full
// line. Files present at start are read from just after their last newline,
// so a line half written before the stream started still arrives once done;
// files that appear later are read from the top. scan() is sync, so watch
// and poll can both call it without racing.
function afterLastNewline(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (let end = fs.fstatSync(fd).size; end > 0;) {
      const start = Math.max(0, end - buf.length);
      const n = fs.readSync(fd, buf, 0, end - start, start);
      const i = buf.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) return start + i + 1;
      end = start;
    }
    return 0;
  } catch { return 0; } finally { fs.closeSync(fd); }
}

function followBoard({ dir = progressDir(), emit, pollMs = 1000 } = {}) {
  const offsets = new Map();
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return null; } };
  const list = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { return []; } };
  for (const f of list()) offsets.set(f, afterLastNewline(path.join(dir, f)));

  function readNew(f) {
    const file = path.join(dir, f);
    const size = sizeOf(file);
    if (size === null) return;
    let from = offsets.get(f) || 0;
    if (size < from) from = 0; // truncated or replaced: start over
    if (size === from) { offsets.set(f, from); return; }
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(size - from);
        buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
      } finally { fs.closeSync(fd); }
    } catch { return; }
    // Stop at the last newline; a half-written tail waits for the next scan.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) { offsets.set(f, from); return; }
    offsets.set(f, from + end + 1);
    const member = f.slice(0, -'.log'.length);
    for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
      const event = progressEvent(member, raw.replace(/\r$/, ''));
      if (event) emit(event);
    }
  }

  let watcher = null;
  let stopped = false;
  function scan() {
    if (stopped) return;
    if (!watcher) {
      try {
        watcher = fs.watch(dir, () => scan());
        watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
      } catch { watcher = null; }
    }
    for (const f of list()) readNew(f);
  }
  const timer = setInterval(scan, pollMs);
  scan();
  return {
    scan,
    stop() {
      stopped = true;
      clearInterval(timer);
      if (watcher) { try { watcher.close(); } catch {} }
    },
  };
}

// Stop a member's live run: SIGTERM its process group (the engine is spawned
// detached, so the group is the run and everything it started), wait up to
// graceMs, then SIGKILL whatever is left. Writes "finished: stopped" so the
// board stops counting it. Resolves { ok, message } with one plain line.
function signalRun(pid, sig) {
  try { process.kill(-pid, sig); return; } catch {}
  try { process.kill(pid, sig); } catch {}
}

function runAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { if (e.code === 'EPERM') return true; }
  return isAlive(pid);
}

// Engines a member run can be, and the program name each one runs as.
const ENGINE_PROGRAMS = Object.freeze({
  claude: ['claude'], fable: ['claude'], haiku: ['claude'], codex: ['codex'],
  cursor: ['cursor-agent'], composer: ['cursor-agent'], grok: ['grok'],
  devin: ['devin'], agy: ['agy'], opencode: ['opencode'],
});

function readProcess(pid) {
  const run = (fmt) => require('child_process').spawnSync('ps', ['-o', fmt, '-p', String(pid)], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  const head = run('pgid=,command=');
  const born = run('lstart=');
  if (head.status !== 0 || born.status !== 0) return null;
  const m = /^\s*(\d+)\s+(.*)$/s.exec(String(head.stdout || '').trim());
  const startedAt = Date.parse(`${String(born.stdout || '').trim()} UTC`);
  return m ? { pgid: Number(m[1]), command: m[2], startedAt: Number.isFinite(startedAt) ? startedAt : null } : null;
}

// Only signal a pid that is, right now, a known engine program leading its
// own process group, and never this process's own group or a system pid.
// The engine process must have started within this many ms of the member's
// own started line, which binds a stop to that exact run.
const START_WINDOW_MS = 30000;

function pidRunsEngine(pid, engine, deps = {}, startedLineAt = null, member = '', run = '') {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const key = String(engine || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ENGINE_PROGRAMS, key)) return false;
  const programs = ENGINE_PROGRAMS[key];
  const info = (deps.readProcess || readProcess)(pid);
  if (!info || info.pgid !== pid) return false;
  if (!Number.isFinite(startedLineAt) || !Number.isFinite(info.startedAt)
    || Math.abs(info.startedAt - startedLineAt) > START_WINDOW_MS) return false;
  const ownGroup = (deps.readProcess || readProcess)(process.pid);
  if (ownGroup && ownGroup.pgid === pid) return false;
  const program = path.basename(String(info.command).trim().split(/\s+/)[0] || '');
  if (!programs.includes(program)) return false;
  // The run token proves the process is this member's run: it is on the first
  // line of the engine's prompt and in no other member's log.
  if (!/^[0-9a-f]{16}$/.test(String(run || '')) || !member) return false;
  // The marker must open the engine's prompt: right after its -p flag, as
  // whole words, so a command that merely mentions it does not count.
  const escaped = runMarker(member, run).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?:^|\\s)-p\\s+${escaped}(?=\\s|\\?|$)`).test(String(info.command))) return false;
  return { startedAt: info.startedAt, command: info.command };
}

async function stopMember(name, { dir = progressDir(), graceMs = 10000, pollMs = 100, now = () => Date.now(), deps = {} } = {}) {
  const nothing = { ok: false, message: 'nothing running' };
  const member = String(name || '').trim();
  if (!member || !/^[A-Za-z0-9._-]+$/.test(member)) return nothing;
  const file = path.join(dir, `${member}.log`);
  let text = '';
  try { text = readTail(file); } catch { return nothing; }
  const current = currentRun(text);
  if (!current || current.finished || !current.startedLine) return nothing;
  const { pid, engine, run } = current.meta;
  if (pid === null || !runAlive(pid)) return nothing;
  // A pid from a run that died without a finished line can be reused by an
  // unrelated program; only signal it while its command is still the engine.
  const identity = pidRunsEngine(pid, engine, deps, current.startedLine.at, member, run);
  if (!identity) return nothing;

  const startedAt = current.startedLine.at;
  signalRun(pid, 'SIGTERM');
  const deadline = now() + graceMs;
  // Poll on timers, not a busy loop, so a test parent can reap its child.
  while (runAlive(pid) && now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  // Check identity again before the hard kill: the pid may have been reused.
  // Before the hard kill, the process must be the very same one: same start
  // time and same command, token included.
  const again = runAlive(pid) && pidRunsEngine(pid, engine, deps, current.startedLine.at, member, run);
  const forced = Boolean(again) && again.startedAt === identity.startedAt && again.command === identity.command;
  if (forced) signalRun(pid, 'SIGKILL');

  const mission = current.startedLine.mission || '-';
  try { fs.appendFileSync(file, `${new Date().toISOString()} ${mission} finished: stopped\n`, 'utf8'); } catch {}
  const how = forced ? ', it had to be forced' : '';
  return { ok: true, pid, forced, message: `stopped ${member} after ${span(now() - startedAt)} of work${how}` };
}

async function memberStopCommand(name) {
  const result = await stopMember(name);
  console.log(result.message);
}

function memberBoardCommand(...args) {
  const asJson = args.includes('--json');
  const all = args.includes('--all');
  if (args.includes('--follow')) {
    const dir = progressDir();
    const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
    write({ kind: 'snapshot', at: new Date().toISOString(), dir, members: readBoard({ dir, all }) });
    const follower = followBoard({ dir, emit: write });
    // Runs until ctrl-c or the reader closes the pipe.
    return new Promise((resolve) => {
      const done = () => { follower.stop(); resolve(); };
      process.once('SIGINT', done);
      process.stdout.once('error', done);
    });
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: true, dir: progressDir(), members: readBoard({ all }) }, null, 2));
    return;
  }
  const draw = () => {
    const every = readBoard({ all: true });
    const rows = all ? every : every.filter((r) => !r.idle);
    return renderBoard(rows, progressDir(), every.length - rows.length);
  };
  if (!args.includes('--watch')) {
    console.log(draw());
    return;
  }
  const redraw = () => process.stdout.write(`\x1b[2J\x1b[H${draw()}\n\nredraws every 3s, ctrl-c to stop\n`);
  redraw();
  // The member route exits once this settles, so only settle on ctrl-c.
  return new Promise((resolve) => {
    const timer = setInterval(redraw, 3000);
    process.once('SIGINT', () => { clearInterval(timer); resolve(); });
  });
}

module.exports = {
  readBoard, renderBoard, memberRow, ago, progressEvent, followBoard, memberBoardCommand,
  parseStarted, isAlive, stopMember, memberStopCommand,
};

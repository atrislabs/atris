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
const REASON_WIDTH = 30;

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

// How the member's most recent finished run ended: ok, failed, or stopped.
// Looks past the current run, so a member busy again still shows how its
// last job went. A stop wins over a "finished: failed" in the same run.
function lastResult(text) {
  const lines = text.split('\n').map(parseLine).filter(Boolean);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.startsWith('finished:')) { end = i; break; }
  }
  if (end < 0) return null;
  let start = 0;
  for (let i = end; i >= 0; i--) {
    if (lines[i].text.startsWith('started:')) { start = i; break; }
  }
  const finishes = lines.slice(start, end + 1).filter((l) => l.text.startsWith('finished:'));
  const stop = finishes.find((l) => /^finished:\s*stopped\b/.test(l.text));
  const line = stop || lines[end];
  const m = /^finished:\s*(\S*)\s*(.*)$/.exec(line.text);
  const began = lines[start].text.startsWith('started:') ? lines[start].at : null;
  return { result: m[1] || 'done', reason: failReason(m[1], m[2]), ran: began === null ? '' : span(line.at - began), at: line.at };
}

// What the board says about a failure: the written reason, or, when the
// runner wrote none, how long the run lasted, so "after 2s" (it never got
// going) reads apart from "after 30m" (it ran long).
function whyFailed(r) {
  if (r.last_result_reason) return r.last_result_reason;
  return r.last_result === 'failed' && r.last_result_ran ? `after ${r.last_result_ran}` : '';
}

// Why a run failed, from the words after "failed" on its finished line:
// "finished: failed (timed out)" -> "timed out". Empty when none was written.
function failReason(word, rest) {
  if (word !== 'failed') return '';
  return cut(String(rest || '').trim().replace(/^\((.*)\)$/, '$1'), REASON_WIDTH);
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
  const result = lastResult(text);
  return {
    member: name,
    state,
    last_result: result ? result.result : '',
    last_result_reason: result ? result.reason : '',
    last_result_ran: result ? result.ran : '',
    last_result_ago: result ? ago(now - result.at) : '',
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

// A member put to sleep says so on the board, even with no progress log.
// Sleep does not end a run already going, so that run reads as finishing.
function markAsleep(row) {
  const live = (row.state === 'working' || row.state === 'quiet') && row.alive !== false;
  return { ...row, state: live ? 'asleep after this run' : 'asleep', asleep: true, idle: false };
}

function asleepRow(member) {
  return {
    member, state: 'asleep', last_result: '', last_result_reason: '', last_result_ran: '', last_result_ago: '', asleep: true, pid: null, engine: '', alive: null,
    running_for: '', job: '', step: '', ago: '-', at: 0, idle: false,
  };
}

// The progress folder is shared by every project on this computer. `only`
// names the members to show; null shows every log.
function readBoard({ dir = progressDir(), now = Date.now(), all = false, asleep = [], only = null } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch {}
  if (only) files = files.filter((f) => only.includes(f.slice(0, -'.log'.length)));
  const sleeping = new Set(asleep);
  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = readTail(path.join(dir, f)); } catch { continue; }
    const row = memberRow(f.slice(0, -'.log'.length), text, now);
    if (row) rows.push(sleeping.has(row.member) ? markAsleep(row) : { ...row, asleep: false });
  }
  for (const name of sleeping) {
    if (!rows.some((r) => r.member === name)) rows.push(asleepRow(name));
  }
  return rows.filter((r) => all || !r.idle).sort((a, b) => b.at - a.at);
}

// Members of this project: one folder each under atris/team. Outside an
// Atris project there is no team, so the board shows every log (null).
function teamHere(root = process.cwd()) {
  try {
    return fs.readdirSync(path.join(root, 'atris', 'team'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !/^[._]/.test(e.name))
      .map((e) => e.name);
  } catch { return null; }
}

// Members the sleep switch has off in this workspace.
function sleepingHere() {
  try { return require('./member-switches').asleepMembers(process.cwd()); } catch { return []; }
}

// The job and last step columns give way first when the board is wider than
// the terminal; each keeps at least its header. width 0 never trims.
const MIN_TEXT_WIDTH = 9;
const OPTIONAL_COLUMNS = Object.freeze(['alive', 'engine', 'running for']);

function fitText(cells, widths, width) {
  if (!width) return;
  const [job, step] = [widths.length - 2, widths.length - 1];
  const prefix = widths.slice(0, job).reduce((n, w) => n + w + 2, 0);
  const room = width - prefix - 2;
  if (widths[job] + widths[step] <= room) return;
  const jobW = Math.max(MIN_TEXT_WIDTH, Math.min(widths[job], Math.max(Math.floor(room / 2), room - widths[step])));
  const stepW = Math.max(MIN_TEXT_WIDTH, room - jobW);
  for (const c of cells) { c[job] = cut(c[job], jobW); c[step] = cut(c[step], stepW); }
  widths[job] = Math.min(widths[job], jobW);
  widths[step] = Math.min(widths[step], stepW);
}

// height caps the lines the board may use (0 never caps). Past it, failed
// and stopped rows stay first, then the most recently active, still in board
// order, and one line says how many did not fit.
function renderBoard(rows, dir = progressDir(), hidden = 0, width = 0, height = 0) {
  const note = hidden ? `${hidden} finished over an hour ago, hidden. --all shows them` : '';
  if (!rows.length) return note ? `nobody is working right now. ${note}` : `no member progress yet in ${dir}`;
  const fits = height && rows.length + 1 + (note ? 2 : 0) > height ? Math.max(1, height - 3) : rows.length;
  const short = rows.length - fits;
  const urgent = (r) => r.state === 'done failed' || r.state === 'stopped';
  const picked = new Set(rows.map((r, i) => i).sort((a, b) => urgent(rows[b]) - urgent(rows[a]) || a - b).slice(0, fits));
  const left = rows.filter((_, i) => !picked.has(i));
  const tally = ['done failed', 'stopped']
    .map((st) => [left.filter((r) => r.state === st).length, st.replace('done ', '')])
    .filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(', ');
  rows = rows.filter((_, i) => picked.has(i));
  const cells = rows.map((r) => [
    r.member,
    r.state,
    r.last_result ? `${r.last_result}${whyFailed(r) ? ` (${whyFailed(r)})` : ''} ${r.last_result_ago}` : '-',
    r.alive === null ? '-' : (r.alive ? 'yes' : 'no'),
    r.engine || '-',
    r.running_for || '-',
    r.ago,
    r.job || '-',
    r.step || '-',
  ]);
  let head = ['member', 'state', 'last result', 'alive', 'engine', 'running for', 'ago', 'job', 'last step'];
  // On a terminal, alive, engine, and running for leave when no row has a
  // value there; old runs without a pid tag fill them with "-" only. If they
  // would still push the board past the window, they fold into one run
  // column that names a live run's engine and age: "claude 2m". A done row's
  // last result is that same run, so there it shrinks to just the reason.
  if (width) {
    const shown = head.map((h, i) => !OPTIONAL_COLUMNS.includes(h) || cells.some((c) => c[i] !== '-'));
    // Too narrow: the columns before job, plus job and last step at their
    // smallest, do not fit.
    const before = head.slice(0, 7).reduce((n, h, i) => (shown[i] ? n + 2 + Math.max(h.length, ...cells.map((c) => c[i].length)) : n), 0);
    const narrow = before + MIN_TEXT_WIDTH + 2 + MIN_TEXT_WIDTH > width;
    if (narrow) rows.forEach((r, k) => { if (r.state.startsWith('done ')) cells[k][2] = whyFailed(r) || '-'; });
    const live = rows.map((r) => (r.alive ? `${r.engine || 'live'} ${r.running_for}`.trim() : '-'));
    const keep = head.map((h, i) => shown[i] && (!narrow || !OPTIONAL_COLUMNS.includes(h)));
    const fold = narrow && live.some((v) => v !== '-');
    head = head.filter((_, i) => keep[i]);
    for (const c of cells) c.splice(0, c.length, ...c.filter((_, i) => keep[i]));
    if (fold) {
      head.splice(3, 0, 'run');
      cells.forEach((c, k) => c.splice(3, 0, live[k]));
    }
    // A busy row's last result is an earlier run. If it still overflows, it
    // drops "ago", then the reason: "failed (bad exit 2) 14m" -> "failed 14m".
    const over = () => head.slice(0, -2).reduce((n, h, i) => n + 2 + Math.max(h.length, ...cells.map((c) => c[i].length)), 0)
      + MIN_TEXT_WIDTH + 2 + MIN_TEXT_WIDTH > width;
    const earlier = rows.map((r, k) => (narrow && r.last_result && !r.state.startsWith('done ') ? k : -1)).filter((k) => k >= 0);
    const shorter = [
      (r) => `${r.last_result}${whyFailed(r) ? ` (${whyFailed(r)})` : ''} ${r.last_result_ago.replace(/ ago$/, '')}`,
      (r) => `${r.last_result} ${r.last_result_ago.replace(/ ago$/, '')}`,
    ];
    for (const form of shorter) {
      if (!earlier.length || !over()) break;
      for (const k of earlier) cells[k][2] = form(rows[k]);
    }
  }
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  fitText(cells, widths, width);
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [line(head)];
  for (const c of cells) out.push(line(c));
  const shortNote = short ? `${short} more not shown${tally ? ` (${tally})` : ''}, the window is too short` : '';
  if (note || short) out.push('', [shortNote, note].filter(Boolean).join('. '));
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

function followBoard({ dir = progressDir(), emit, pollMs = 1000, orderByTime = false } = {}) {
  const offsets = new Map();
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return null; } };
  const list = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { return []; } };
  for (const f of list()) offsets.set(f, afterLastNewline(path.join(dir, f)));

  function readNew(f, events) {
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
      if (event) events.push(event);
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
    const events = [];
    for (const f of list()) readNew(f, events);
    if (orderByTime) events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const event of events) emit(event);
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
// Engines whose member run may be led by the login shell that launched them.
const SHELL_LAUNCHED = Object.freeze(['codex']);

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
  // The codex mission runner leads its group with a login shell whose script
  // opens with the marker as a no-op: sh -lc ': atris-run <member> <run>; ...'.
  const viaShell = SHELL_LAUNCHED.includes(key) && program === 'sh';
  if (!programs.includes(program) && !viaShell) return false;
  // The run token proves the process is this member's run: it is on the first
  // line of the engine's prompt and in no other member's log.
  if (!/^[0-9a-f]{16}$/.test(String(run || '')) || !member) return false;
  // The marker must open the engine's prompt: right after its -p flag, as
  // whole words, so a command that merely mentions it does not count.
  const escaped = runMarker(member, run).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The program, then -p, then the marker: nothing earlier can carry it. ps on
  // macOS prints the prompt's line break as the four characters \\012.
  const shape = viaShell
    ? `^\\S+\\s+-lc\\s+:\\s+${escaped};`
    : `^\\S+\\s+-p\\s+${escaped}(?=\\s|\\\\012|\\?|$)`;
  if (!new RegExp(shape).test(String(info.command))) return false;
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
  const only = teamHere();
  if (args.includes('--follow')) {
    const dir = progressDir();
    const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
    write({ kind: 'snapshot', at: new Date().toISOString(), dir, members: readBoard({ dir, all, asleep: sleepingHere(), only }) });
    const follower = followBoard({ dir, emit: (event) => { if (!only || only.includes(event.member)) write(event); } });
    // Runs until ctrl-c or the reader closes the pipe.
    return new Promise((resolve) => {
      const done = () => { follower.stop(); resolve(); };
      process.once('SIGINT', done);
      process.stdout.once('error', done);
    });
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: true, dir: progressDir(), members: readBoard({ all, asleep: sleepingHere(), only }) }, null, 2));
    return;
  }
  const draw = (height = 0) => {
    const every = readBoard({ all: true, asleep: sleepingHere(), only });
    const rows = all ? every : every.filter((r) => !r.idle);
    const width = process.stdout.isTTY ? process.stdout.columns || 0 : 0;
    return renderBoard(rows, progressDir(), every.length - rows.length, width, height);
  };
  if (!args.includes('--watch')) {
    console.log(draw());
    return;
  }
  // The footer, the blank line above it, and the cursor line below take 3.
  const tall = () => (process.stdout.isTTY ? Math.max(0, (process.stdout.rows || 0) - 3) : 0);
  const redraw = () => process.stdout.write(`\x1b[2J\x1b[H${draw(tall())}\n\nredraws every 3s, ctrl-c to stop\n`);
  redraw();
  // The member route exits once this settles, so only settle on ctrl-c.
  return new Promise((resolve) => {
    const timer = setInterval(redraw, 3000);
    process.once('SIGINT', () => { clearInterval(timer); resolve(); });
  });
}

module.exports = {
  readBoard, renderBoard, memberRow, ago, progressEvent, followBoard, memberBoardCommand,
  parseStarted, teamHere, isAlive, stopMember, memberStopCommand,
};

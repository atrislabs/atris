'use strict';

// One screen of every member with a progress log: what job it is on, its last
// step, how long ago that was, and whether it is working, quiet, done,
// stopped by `atris member stop`, or died without finishing.
// Reads the logs lib/member-progress.js writes: "<iso> <mission> <text>".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUN_TAG, runMarker } = require('./member-progress');

const QUIET_AFTER_MS = 2 * 60 * 1000;
const HIDE_DONE_AFTER_MS = 60 * 60 * 1000;
const SILENT_AFTER_MS = 60 * 60 * 1000;
const CHANGE_KEEP_MS = 60 * 1000;
const TAIL_BYTES = 256 * 1024;
// Rows keep up to TEXT_MAX of the job and step; the screen cuts them to fit
// the terminal, or to PIPE_WIDTH each when there is no terminal to measure.
const TEXT_MAX = 200;
const PIPE_WIDTH = 50;
const MIN_WIDTH = 20;

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

// How each run before the current one ended, newest first, up to n. A run
// with no finished line was cut off when the next one started. It died only
// if it had a pid and that process is gone; otherwise the board cannot tell
// how it ended, so it reads "replaced".
function earlierOutcomes(text, n = 3) {
  const runs = [];
  for (const l of text.split('\n').map(parseLine).filter(Boolean)) {
    if (l.text.startsWith('started:')) runs.push({ pid: parseStarted(l.text).pid, done: [] });
    else if (runs.length && l.text.startsWith('finished:')) runs[runs.length - 1].done.push(l.text);
  }
  return runs.slice(0, -1).reverse().slice(0, n).map(({ pid, done }) => {
    if (done.some((t) => /^finished:\s*stopped\b/.test(t))) return 'stopped';
    if (!done.length) return pid !== null && !isAlive(pid) ? 'died' : 'replaced';
    return /^finished:\s*ok\b/.test(done[done.length - 1]) ? 'ok' : 'failed';
  });
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
  // The process is gone but never wrote a finished line: it crashed or was
  // killed outside `atris member stop`, so it is not a clean stop.
  else if (alive === false) state = 'died';
  else state = now - last.at < QUIET_AFTER_MS ? 'working' : 'quiet';
  const ended = !['working', 'quiet'].includes(state);
  // A run with no pid that stop put away after an hour of silence: the stop
  // line says when it was cleared, not when it ended, so its length runs to
  // the last line before the stop, like a crash.
  const stopAt = stopped && meta.pid === null ? run.findIndex((l) => /^finished:\s*stopped\b/.test(l.text)) : -1;
  const putAway = stopAt > 0 && run[stopAt].at - run[stopAt - 1].at >= SILENT_AFTER_MS;
  const end = putAway ? run[stopAt - 1] : (finished || last);
  const atLeast = state === 'died' || putAway;
  // The last time the run itself did anything. A put-away run's stop line is
  // when someone cleared it, so it does not count as activity.
  const seen = putAway ? run[stopAt - 1] : last;
  return {
    member: name,
    // The mission this run belongs to, from its progress lines, so an app can
    // link the row to that mission.
    mission: (startedLine || last).mission,
    state,
    before: earlierOutcomes(text),
    pid: meta.pid,
    engine: meta.engine,
    // null when the started line has no pid; false once the run is over.
    alive: meta.pid === null ? null : alive === true,
    // Time since start for a run that has not ended. With no pid the board
    // cannot confirm it is still going, but the start time is still known.
    running_for: !ended && startedLine ? span(now - startedLine.at) : '',
    // When the run started, as a readable time; '' if it logged no start.
    started_at: startedLine ? new Date(startedLine.at).toISOString() : '',
    // How long an ended run took: start to its finished line, or to its last
    // line when it died without one. Empty while the run may still be going,
    // and empty when it died before logging past its start: "0s" would claim
    // a length the board never saw.
    lasted: ended && startedLine && ((finished && !putAway) || end !== startedLine) ? span(end.at - startedLine.at) : '',
    // The run may have gone on past its lasted time: it died, or went silent
    // until stop put it away. The screen says "at least".
    lasted_at_least: Boolean(ended && atLeast),
    // Stop cleared it after an hour or more of silence, with no process to end.
    put_away: putAway,
    job: startedLine ? cut(meta.job, TEXT_MAX) : '',
    step: step ? cut(step.text, TEXT_MAX) : '',
    ago: ago(now - seen.at),
    at: seen.at,
    // The same moment as a readable time, so an app can show it without
    // the "ago" text going stale after the snapshot.
    last_active: new Date(seen.at).toISOString(),
    // Ended more than an hour ago, finished or died: off the board unless --all.
    // A run put away after hours of silence ended then, so it leaves at once.
    idle: ended && now - seen.at >= HIDE_DONE_AFTER_MS,
    // No pid to check and silent for over an hour: most likely it ended
    // without a finished line. A guess, so the state stays quiet.
    likely_ended: !ended && meta.pid === null && now - last.at >= SILENT_AFTER_MS,
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
  // Members that died or failed go first, so trouble is never below the
  // fold; inside each group, newest first.
  const trouble = (r) => (r.state === 'died' || r.state === 'done failed' ? 0 : 1);
  return rows.filter((r) => all || !r.idle).sort((a, b) => trouble(a) - trouble(b) || b.at - a.at);
}

// Split the room left on a line of `columns` between job and step. When
// both fit, nothing is cut; otherwise the shorter keeps its length and the
// longer gets the rest, never below MIN_WIDTH.
function textWidths(columns, used, jobNeed, stepNeed) {
  if (!Number.isInteger(columns) || columns <= 0) return [PIPE_WIDTH, PIPE_WIDTH];
  const room = columns - used;
  if (jobNeed + stepNeed <= room) return [jobNeed, stepNeed];
  const half = Math.floor(room / 2);
  let job = half;
  if (jobNeed <= half) job = jobNeed;
  else if (stepNeed <= half) job = room - stepNeed;
  return [Math.max(MIN_WIDTH, job), Math.max(MIN_WIDTH, room - job)];
}

// One line above the table that counts members by state, trouble first,
// e.g. "4 members: 1 died, 2 working, 1 stopped".
const SUMMARY_ORDER = ['died', 'done failed', 'working', 'quiet', 'stopped', 'done ok'];
// How many rows are in each state. Every state is a key, zero included, so
// apps can read a count without checking that it exists.
function stateCounts(rows) {
  return Object.fromEntries(SUMMARY_ORDER.map((s) => [s, rows.filter((r) => r.state === s).length]));
}

function teamSummary(rows) {
  const counts = Object.entries(stateCounts(rows)).filter(([, n]) => n);
  const total = `${rows.length} member${rows.length === 1 ? '' : 's'}`;
  return `${total}: ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}`;
}

// Remembers each member's state between watch redraws and returns the
// changes seen in the last keepMs, oldest first, like "builder working -> died",
// or "builder working -> died -> working" when it changed twice in that time
// or its run ended and the next one started between two redraws.
// The first call has nothing to compare with, so it returns none. Pass every
// row, hidden ones too, so a run that leaves the screen as it changes is still
// named. A put-away run says when it last did anything, since the stop is not,
// and so does any run hidden off the board, where its ago column is not shown.
// How an earlier run ended, from the before column, as a board state.
const ENDED_AS = { ok: 'done ok', failed: 'done failed', stopped: 'stopped', died: 'died', replaced: 'replaced' };
// A run is its mission, pid and start time; a run with no pid that restarts
// on the same mission differs only by its start.
const runKey = (r) => `${r.mission} ${r.pid} ${r.started_at}`;

function changeTracker(keepMs = CHANGE_KEEP_MS) {
  let prev = null;
  const recent = new Map();
  return (rows, now = Date.now()) => {
    if (prev) {
      for (const r of rows) {
        // A replaced run whose process later turns out gone died; the note
        // takes the before column's word so the screen agrees with itself.
        const noted = recent.get(r.member);
        if (noted && noted.unsure && noted.unsure.run === runKey(r) && (r.before || [])[0] === 'died') {
          noted.path[noted.unsure.at] = 'died';
          noted.text = `${r.member} ${noted.path.join(' -> ')}${noted.how}`;
          noted.unsure = null;
        }
        const before = prev.get(r.member);
        if (!before) continue;
        const was = before.state;
        // An unfinished run replaced by the member's next one ended between
        // redraws; "before" says how, so working then working still names it.
        const replaced = before.run !== runKey(r) && ['working', 'quiet'].includes(was) && ENDED_AS[(r.before || [])[0]];
        const steps = replaced ? [replaced, r.state] : [r.state];
        if (!replaced && was === r.state) continue;
        const how = r.put_away || r.idle ? `, last active ${r.ago}` : '';
        // A second change inside the window extends the note, so a crash
        // followed by a quick restart still shows the crash.
        const c = recent.get(r.member);
        const open = c && now - c.at <= keepMs;
        const path = open ? [...c.path, ...steps] : [was, ...steps];
        // Keep a pending fix across this run's own later changes.
        const unsure = replaced === 'replaced' ? { at: path.length - 2, run: runKey(r) } : (open ? c.unsure : null);
        recent.set(r.member, { path, how, unsure, text: `${r.member} ${path.join(' -> ')}${how}`, at: now });
      }
    }
    prev = new Map(rows.map((r) => [r.member, { state: r.state, run: runKey(r) }]));
    for (const [m, c] of recent) if (now - c.at > keepMs) recent.delete(m);
    return [...recent.values()].sort((a, b) => a.at - b.at).map((c) => c.text);
  };
}

function renderBoard(rows, dir = progressDir(), hidden = 0, columns = null, changes = []) {
  const note = hidden ? `${hidden} ended over an hour ago, hidden. --all shows them` : '';
  const changeLine = changes.length ? `changed in the last minute: ${changes.join(', ')}` : '';
  // The last shown run can hide in the same redraw it changes in, so the
  // empty board still says what changed.
  if (!rows.length) {
    const empty = note ? `nobody is working right now. ${note}` : `no member progress yet in ${dir}`;
    return changeLine ? `${changeLine}\n\n${empty}` : empty;
  }
  const cells = rows.map((r) => [
    r.member,
    r.state,
    r.before.join(' ') || '-',
    r.alive === null ? '-' : (r.alive ? 'yes' : 'no'),
    r.engine || '-',
    // A died or put-away run's length stops at its last line; it may have run on after.
    r.running_for || (r.lasted && r.lasted_at_least ? `at least ${r.lasted}` : r.lasted) || '-',
    r.ago,
    r.job || '-',
    r.step || '-',
  ]);
  const fullHead = ['member', 'state', 'before', 'alive', 'engine', 'run time', 'ago', 'job', 'last step'];
  // before, alive, engine and run time leave the screen when every row says
  // "-": runs started without a pid or engine tag would fill two columns
  // with nothing, and job and last step get the room instead.
  const optional = [2, 3, 4, 5];
  const keep = fullHead.map((_, i) => !optional.includes(i) || cells.some((c) => c[i] !== '-'));
  const head = fullHead.filter((_, i) => keep[i]);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].filter((_, i) => keep[i]);
  const [jobAt, stepAt] = [head.length - 2, head.length - 1];
  const fit = (i) => Math.max(head[i].length, ...cells.map((c) => c[i].length));
  const fixed = head.slice(0, -2).reduce((sum, _, i) => sum + fit(i) + 2, 0) + 2;
  const [jobWidth, stepWidth] = textWidths(columns, fixed, fit(jobAt), fit(stepAt));
  for (const c of cells) { c[jobAt] = cut(c[jobAt], jobWidth); c[stepAt] = cut(c[stepAt], stepWidth); }
  const widths = head.map((h, i) => fit(i));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [teamSummary(rows)];
  if (changeLine) out.push(changeLine);
  out.push('', line(head));
  for (const c of cells) out.push(line(c));
  const unchecked = uncheckedCount(rows);
  const blind = unchecked
    ? `${unchecked} unfinished run${unchecked === 1 ? '' : 's'} recorded no process id, so a crash there shows as working or quiet, not died`
    : '';
  const silent = rows.filter((r) => r.likely_ended).map((r) => r.member);
  const gone = silent.length
    ? `${silent.join(', ')} ${silent.length === 1 ? 'has' : 'have'} logged nothing for over an hour with no process id to check, so ${silent.length === 1 ? 'it' : 'they'} most likely ended without saying so`
    : '';
  // "replaced" is the board admitting it cannot tell how a run ended; say so.
  // A change note keeps the word for a minute after the column may have
  // learned the run died, so a note that uses it counts too.
  const cutOff = [...new Set([
    ...rows.filter((r) => r.before.includes('replaced')).map((r) => r.member),
    ...changes.filter((c) => c.includes(' -> replaced')).map((c) => c.split(' ')[0]),
  ])];
  const replaced = cutOff.length ? `replaced (${cutOff.join(', ')}): the next run started before that run said how it ended` : '';
  if (note || blind || gone || replaced) out.push('', ...[blind, gone, replaced, note].filter(Boolean));
  return out.join('\n');
}

// Without a pid the board cannot check the process, so a crash in one of
// these runs keeps reading working or quiet instead of died.
function uncheckedCount(rows) {
  return rows.filter((r) => ['working', 'quiet'].includes(r.state) && r.pid === null).length;
}

// Live stream format for `atris member board --json --follow`, one JSON
// object per line on stdout, forever:
//   first line: {"kind":"snapshot","at":"<iso>","dir":"<progress dir>","members":[<same rows as --json>],"counts":{...},"hidden":<n>,"unchecked":<n>}
//   (each row's "last_active" is the time of its last line, an iso string; "at" is the same moment in ms)
//   ("counts" has every state as a key, "died" through "done ok", counting the members shown, zeros included)
//   ("hidden" counts members that ended over an hour ago and were left out; 0 with --all)
//   ("unchecked" counts unfinished runs shown that recorded no process id, so a crash there reads working or quiet, not died)
//   (each row's "before" lists how its earlier runs ended, newest first, up to 3: "ok", "failed", "stopped", "died", "replaced";
//   "died" means the run had a process id and that process is gone, "replaced" means the next run started before
//   that one said how it ended, so the board cannot tell whether it crashed)
//   then one line per new progress line, in the order it was read:
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"started","text":"<job>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"step","text":"<step>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"finished","text":"ok","ok":true}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"finished","text":"stopped","ok":false,"stopped":true}
//   (a started line adds "before", how the member's last run ended, one of the "before" values above;
//   it is left out for a member's first run)
//   (a stop that put away a run silent for over an hour adds "put_away":true and
//   "last_active":"<iso>", its last line before the stop; "at" is when it was cleared)
//   and, right after a started or finished line that changes it:
//     {"kind":"unchecked","at":"<iso>","unchecked":<n>}
//   (the new "unchecked" count from the snapshot, so an app's warning stays current)
//   and, within a few seconds of a run's process going away with no finished line:
//     {"kind":"died","member":"builder","mission":"m-1","at":"<iso>","pid":4242,"job":"<job>","step":"<last step>","lasted":"12m","last_active":"<iso>"}
//   ("step" is "" if the run logged none; "lasted" runs from start to its last line, since the crash time is unknown;
//   "last_active" is that last line's time, and "at" is when the crash was found)
//   (only runs that started with a pid can be seen to die; "unchecked" counts the rest)
//   (a run that died and was replaced by the member's next run between two checks is still
//   reported, just before the next run's started line)
// "ok" appears only on finished. "stopped" appears only on a clean stop
// from `atris member stop`, so a stop is not read as a failure. Lines that are not "<iso> <mission> <text>"
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
    if (tagged[1] === 'finished') {
      event.ok = /^ok\b/.test(tagged[2]);
      if (/^stopped\b/.test(tagged[2])) event.stopped = true;
    }
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
  // The program, then -p, then the marker: nothing earlier can carry it. ps on
  // macOS prints the prompt's line break as the four characters \\012.
  if (!new RegExp(`^\\S+\\s+-p\\s+${escaped}(?=\\s|\\\\012|\\?|$)`).test(String(info.command))) return false;
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
  // No pid to signal and silent past the board's likely-ended mark: write its
  // finished line so the row can be put away. Nothing is killed.
  if (pid === null) {
    const quietFor = now() - current.run[current.run.length - 1].at;
    if (!(quietFor >= SILENT_AFTER_MS)) return nothing;
    try {
      fs.appendFileSync(file, `${new Date(now()).toISOString()} ${current.startedLine.mission || '-'} finished: stopped\n`, 'utf8');
    } catch { return nothing; }
    return { ok: true, pid: null, forced: false, message: `marked ${member} stopped, it logged nothing for ${span(quietFor)} and had no process to end` };
  }
  if (!runAlive(pid)) return nothing;
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

// The run before the current one, as a board row, or null if there is none.
// Its state reads died when its process is gone, since it never finished.
function previousRun(name, text, now = Date.now()) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = parseLine(lines[i]);
    if (l && l.text.startsWith('started:')) return memberRow(name, lines.slice(0, i).join('\n'), now);
  }
  return null;
}

// Returns a check that writes one "died" line per run that has died since
// the last check. Runs already dead in the first rows are known, not news.
// A run can die and be replaced by the member's next run between two checks,
// so a tracked run that is gone from the rows is looked up with previous().
function watchCrashes(rows, emit, read, previous = () => null) {
  const key = (r) => `${r.member} ${r.mission} ${r.pid}`;
  const seen = new Set(rows.filter((r) => r.state === 'died').map(key));
  const open = new Map();
  const track = (r) => {
    if (['working', 'quiet'].includes(r.state) && r.pid !== null) open.set(r.member, key(r));
    else open.delete(r.member);
  };
  rows.forEach(track);
  const report = (r) => {
    if (r.state !== 'died' || seen.has(key(r))) return;
    seen.add(key(r));
    emit({
      kind: 'died', member: r.member, mission: r.mission, at: new Date().toISOString(),
      pid: r.pid, job: r.job, step: r.step, lasted: r.lasted,
      // When the run last logged anything; "at" is only when the crash was found.
      last_active: r.last_active,
    });
  };
  return () => {
    for (const r of read()) {
      const was = open.get(r.member);
      if (was && was !== key(r)) {
        const p = previous(r.member);
        if (p && key(p) === was) report(p);
      }
      report(r);
      track(r);
    }
  };
}

// The rows to show, how many are in each state, how many ended over an
// hour ago and were left out, and how many unfinished runs cannot be checked
// for a crash.
// Every view (screen, --json, the --follow snapshot) counts them the same way.
function boardView({ dir = progressDir(), all = false, every = readBoard({ dir, all: true }) } = {}) {
  const members = all ? every : every.filter((r) => !r.idle);
  return { members, counts: stateCounts(members), hidden: every.length - members.length, unchecked: uncheckedCount(members) };
}

function memberBoardCommand(...args) {
  const asJson = args.includes('--json');
  const all = args.includes('--all');
  if (args.includes('--follow')) {
    const dir = progressDir();
    const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
    const view = boardView({ dir, all });
    write({ kind: 'snapshot', at: new Date().toISOString(), dir, ...view });
    // Only a started or finished line can change how many unfinished runs
    // lack a pid, so only those recount, and only a change is written.
    let unchecked = view.unchecked;
    // A crash writes no line, so the stream checks pids on its own.
    const previous = (member) => {
      try { return previousRun(member, readTail(path.join(dir, `${member}.log`))); } catch { return null; }
    };
    const checkCrashes = watchCrashes(view.members, write, () => readBoard({ dir, all: true }), previous);
    const send = (event) => {
      if (event.kind !== 'started' && event.kind !== 'finished') { write(event); return; }
      // A start can replace a run that just died; name that crash first, so
      // an app reading in order never sees the new run before it.
      if (event.kind === 'started') checkCrashes();
      const rows = readBoard({ dir, all: true });
      // A stop that put away a silent run is not a fresh finish: say so, and
      // when the run last did anything.
      const row = event.stopped && rows.find((r) => r.member === event.member && r.mission === event.mission);
      if (row && row.put_away) Object.assign(event, { put_away: true, last_active: row.last_active });
      // A new run says how the member's last one ended, as the before column does.
      const fresh = event.kind === 'started' && rows.find((r) => r.member === event.member && r.started_at === event.at);
      if (fresh && fresh.before.length) event.before = fresh.before[0];
      write(event);
      const count = uncheckedCount(rows);
      if (count === unchecked) return;
      unchecked = count;
      write({ kind: 'unchecked', at: new Date().toISOString(), unchecked });
    };
    const follower = followBoard({ dir, emit: send });
    const crashes = setInterval(checkCrashes, 2000);
    // Runs until ctrl-c or the reader closes the pipe.
    return new Promise((resolve) => {
      const done = () => { clearInterval(crashes); follower.stop(); resolve(); };
      process.once('SIGINT', done);
      process.stdout.once('error', done);
    });
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: true, dir: progressDir(), ...boardView({ all }) }, null, 2));
    return;
  }
  // Only --watch redraws, so only it ever sees a change.
  const changed = changeTracker();
  const draw = () => {
    const every = readBoard({ all: true });
    const { members, hidden } = boardView({ all, every });
    // Piped output has no width to measure, so it keeps the fixed cut.
    const columns = process.stdout.isTTY ? process.stdout.columns : null;
    return renderBoard(members, progressDir(), hidden, columns, changed(every));
  };
  if (!args.includes('--watch')) {
    console.log(draw());
    return;
  }
  // The clock time in the footer moves on every redraw, so a frozen
  // terminal shows an old time instead of looking live.
  const redraw = () => process.stdout.write(`\x1b[2J\x1b[H${draw()}\n\nredrawn at ${new Date().toTimeString().slice(0, 8)}, redraws every 3s, ctrl-c to stop\n`);
  redraw();
  // The member route exits once this settles, so only settle on ctrl-c.
  return new Promise((resolve) => {
    const timer = setInterval(redraw, 3000);
    process.once('SIGINT', () => { clearInterval(timer); resolve(); });
  });
}

module.exports = {
  readBoard, renderBoard, changeTracker, memberRow, ago, progressEvent, followBoard, memberBoardCommand,
  parseStarted, isAlive, stopMember, memberStopCommand, watchCrashes, previousRun, ENDED_AS,
};

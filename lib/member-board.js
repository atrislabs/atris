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
// With the step on its own line, job takes whatever room is left, down to this.
const STACKED_JOB_MIN = 10;
// Narrow screens give up columns before job until it has this much room:
// at 10, "continuous run" read "continuou..." on an 80 column pane, and at
// 20 a job read "Finish work-folde..." while every row still said "ago".
const JOB_ROOM = 24;

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
// A stop of an earlier run that was still going, written after the newest
// started line: "finished: stopped [pid N]". It belongs to the run with that pid.
const EARLIER_STOP = /^finished:\s*stopped \[pid (\d+)\]$/;
const earlierStopPid = (text) => {
  const m = EARLIER_STOP.exec(text);
  return m ? Number(m[1]) : null;
};

function currentRun(text) {
  const lines = text.split('\n').map(parseLine).filter(Boolean);
  if (!lines.length) return null;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.startsWith('started:')) { start = i; break; }
  }
  const startedLine = lines[start].text.startsWith('started:') ? lines[start] : null;
  const own = parseStarted(startedLine ? startedLine.text : '').pid;
  const run = lines.slice(start).filter((l) => {
    const pid = earlierStopPid(l.text);
    return pid === null || pid === own;
  });
  const finished = [...run].reverse().find((l) => l.text.startsWith('finished:'));
  // A stop wins over the runner's own "finished: failed" that may land first.
  const stopped = run.some((l) => /^finished:\s*stopped\b/.test(l.text));
  return { run, startedLine, finished, stopped, meta: parseStarted(startedLine ? startedLine.text : '') };
}

// How each run before the current one ended, newest first, up to n. A run
// with no finished line was cut off when the next one started. It died only
// if it had a pid and that process is gone; otherwise the board cannot tell
// how it ended, so it reads "replaced". A stop of an earlier run goes to the
// latest run with its pid, wherever the line landed.
function earlierRuns(text) {
  const runs = [];
  for (const l of text.split('\n').map(parseLine).filter(Boolean)) {
    if (l.text.startsWith('started:')) {
      const meta = parseStarted(l.text);
      runs.push({ pid: meta.pid, engine: meta.engine, run: meta.run, at: l.at, mission: l.mission, done: [] });
      continue;
    }
    if (!runs.length || !l.text.startsWith('finished:')) continue;
    const pid = earlierStopPid(l.text);
    const owner = pid === null ? runs[runs.length - 1] : [...runs].reverse().find((r) => r.pid === pid);
    if (owner) owner.done.push(l.text);
  }
  return runs.slice(0, -1);
}

// Whether an earlier run of this mission and pid was ended by a stop.
function stoppedEarlier(text, mission, pid) {
  return earlierRuns(text).some((r) => r.pid === pid && r.mission === mission
    && r.done.some((t) => /^finished:\s*stopped\b/.test(t)));
}

function earlierOutcomes(text, n = 3) {
  return earlierRuns(text).reverse().slice(0, n).map(({ pid, done }) => {
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
    // When each of those runs started, same order, so a redraw can tell how
    // many runs ended since it last looked.
    before_started: earlierRuns(text).reverse().slice(0, 3).map((r) => new Date(r.at).toISOString()),
    // How many earlier runs the log holds, past the 3 kept; null when the
    // log is too long to read whole, so the count is not known.
    earlier_runs: earlierRuns(text).length,
    // Pids of earlier runs that never said how they ended and whose process
    // still lives: the member has more than one run going at once.
    earlier_alive: earlierRuns(text).filter((r) => !r.done.length && r.pid !== null && isAlive(r.pid)).map((r) => r.pid),
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
    // The run's latest "Working on:" goal, '' if it logged none: a continuous
    // run's job says only that, and this says what it is on now.
    working_on: cut((run.filter((l) => l.text.startsWith('Working on: ')).pop()?.text || '').slice('Working on: '.length), TEXT_MAX),
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
    let whole = true;
    try {
      text = readTail(path.join(dir, f));
      whole = fs.statSync(path.join(dir, f)).size <= TAIL_BYTES;
    } catch { continue; }
    const row = memberRow(f.slice(0, -'.log'.length), text, now);
    if (row && !whole) row.earlier_runs = null;
    if (row) rows.push(row);
  }
  // Members that died or failed go first, so trouble is never below the
  // fold. Live runs come next, so one that went quiet is not pushed off a
  // short screen by runs that finished since; a run that most likely ended
  // unsaid waits with the ended ones. Inside each group, newest first.
  const trouble = (r) => {
    if (r.state === 'died' || r.state === 'done failed') return 0;
    return ['working', 'quiet'].includes(r.state) && !r.likely_ended ? 1 : 2;
  };
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
  // The job gets the same floor it has when the step sits on its own line,
  // so a wider screen never shows less of it than a narrow one.
  job = Math.max(job, Math.min(jobNeed, JOB_ROOM));
  return [Math.max(MIN_WIDTH, job), Math.max(MIN_WIDTH, room - job)];
}

// A note wider than the screen, broken between words, with the lines after
// the first indented so it still reads as one note. No width, no change.
function wrapNote(text, columns) {
  if (!Number.isInteger(columns) || columns <= 0 || text.length <= columns) return text;
  const lines = [];
  let at = '';
  for (const word of text.split(' ')) {
    const lead = lines.length ? '  ' : '';
    if (at && `${lead}${at} ${word}`.length > columns) { lines.push(`${lead}${at}`); at = word; } else at = at ? `${at} ${word}` : word;
  }
  lines.push(`${lines.length ? '  ' : ''}${at}`);
  return lines.join('\n');
}

// One line above the table that counts members by state, trouble first,
// e.g. "4 members: 1 died, 2 working, 1 stopped".
const SUMMARY_ORDER = ['died', 'done failed', 'working', 'quiet', 'stopped', 'done ok'];
// How many rows are in each state. Every state is a key, zero included, so
// apps can read a count without checking that it exists.
function stateCounts(rows) {
  return Object.fromEntries(SUMMARY_ORDER.map((s) => [s, rows.filter((r) => r.state === s).length]));
}

// Wider than the screen, it breaks after a comma, so a count and its state
// stay on one line.
function teamSummary(rows, columns = null) {
  const counts = Object.entries(stateCounts(rows)).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`);
  const total = `${rows.length} member${rows.length === 1 ? '' : 's'}`;
  const line = `${total}: ${counts.join(', ')}`;
  if (!Number.isInteger(columns) || columns <= 0 || line.length <= columns) return line;
  const lines = [];
  let at = `${total}:`;
  for (const c of counts) {
    const lead = lines.length ? '  ' : '';
    if (`${lead}${at} ${c},`.length > columns && at !== `${total}:`) { lines.push(`${lead}${at}`); at = c; } else at = `${at} ${c}`;
    at += ',';
  }
  lines.push(`${lines.length ? '  ' : ''}${at.slice(0, -1)}`);
  return lines.join('\n');
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
        // A replaced run whose process later turns out gone died, or was
        // stopped by its pid; the note takes the before column's word so the
        // screen agrees with itself. Died stays open to a fix: a stop's line
        // lands just after its process exits, so one redraw can see died first.
        const noted = recent.get(r.member);
        const word = (r.before || [])[0];
        if (noted && noted.unsure && noted.unsure.run === runKey(r) && ['died', 'stopped'].includes(word)) {
          noted.path[noted.unsure.at] = word;
          noted.text = `${r.member} ${noted.path.join(' -> ')}${noted.how}`;
          if (word === 'stopped') noted.unsure = null;
        }
        // A member missing from the last redraw is new: its first log
        // appeared in between, which a busy screen would not point out.
        const before = prev.get(r.member) || { state: 'new', run: runKey(r) };
        const was = before.state;
        // Runs that ended between redraws, oldest first, from the before
        // column: the last seen run if it was unfinished, so working then
        // working still names it, and any run that started and ended in
        // between, so a quick failure is not hidden. Without the last seen
        // run's start, only the newest ending is known. A new member had no
        // runs at the last redraw, so every earlier run it has ended since.
        const moved = before.run !== runKey(r);
        const open = ['working', 'quiet'].includes(was);
        const words = r.before || [];
        const starts = r.before_started || [];
        const seen = before.started ? starts.indexOf(before.started) : -1;
        // The last seen run fell off the kept runs when every kept run
        // started after it: they all ended in between, and so did more.
        const lost = moved && before.started && seen < 0 && words.length > 0
          && starts.length === words.length && starts.every((s) => s > before.started);
        let ended = [];
        if (was === 'new' || lost) ended = [...words];
        else if (moved) ended = seen >= 0 ? words.slice(0, open ? seen + 1 : seen) : words.slice(0, open ? 1 : 0);
        // How many ended in between but are not kept: the earlier run count
        // grew by every run since the last seen one, that one included.
        const counted = r.earlier_runs;
        const countedBefore = was === 'new' ? 0 : before.earlier;
        const since = Number.isInteger(counted) && Number.isInteger(countedBefore) ? counted - countedBefore - (was === 'new' || open ? 0 : 1) : null;
        const unshown = since === null ? null : since - ended.length;
        let more = [];
        if (unshown > 0) more = [`${unshown} more run${unshown === 1 ? '' : 's'}`];
        else if (lost) more = ['more runs'];
        const between = [...more, ...ended.reverse().map((w) => ENDED_AS[w]).filter(Boolean)];
        const steps = [...between, r.state];
        // A finished run followed by another that ended the same way is
        // still a change.
        if (!between.length && was === r.state && !(moved && !open)) continue;
        const how = r.put_away || r.idle ? `, last active ${r.ago}` : '';
        // A second change inside the window extends the note, so a crash
        // followed by a quick restart still shows the crash.
        const c = recent.get(r.member);
        const kept = c && now - c.at <= keepMs;
        const path = kept ? [...c.path, ...steps] : [was, ...steps];
        // Keep a pending fix across this run's own later changes.
        const unsure = between[between.length - 1] === 'replaced' ? { at: path.length - 2, run: runKey(r) } : (kept ? c.unsure : null);
        recent.set(r.member, { path, how, unsure, text: `${r.member} ${path.join(' -> ')}${how}`, at: now });
      }
    }
    prev = new Map(rows.map((r) => [r.member, { state: r.state, run: runKey(r), started: r.started_at, earlier: r.earlier_runs }]));
    for (const [m, c] of recent) if (now - c.at > keepMs) recent.delete(m);
    return [...recent.values()].sort((a, b) => a.at - b.at).map((c) => c.text);
  };
}

function renderBoard(rows, dir = progressDir(), hidden = 0, columns = null, changes = [], height = null) {
  const note = hidden ? `${hidden} ended over an hour ago, hidden. --all shows them` : '';
  // One line when it fits; wider than the screen, each member gets its own
  // line, broken after an arrow when it is still too long, so a busy minute
  // does not wrap mid-word.
  let changeLine = changes.length ? `changed in the last minute: ${changes.join(', ')}` : '';
  if (changeLine && Number.isInteger(columns) && columns > 0 && changeLine.length > columns) {
    const wrap = (c) => {
      const [first, ...rest] = c.split(' -> ');
      const lines = [];
      let at = `  ${first}`;
      for (const p of rest) {
        if (`${at} -> ${p}`.length > columns) { lines.push(`${at} ->`); at = `    ${p}`; } else at = `${at} -> ${p}`;
      }
      return [...lines, at];
    };
    changeLine = ['changed in the last minute:', ...changes.flatMap(wrap)].join('\n');
  }
  // The last shown run can hide in the same redraw it changes in, so the
  // empty board still says what changed.
  if (!rows.length) {
    // A member's first run makes the folder, so a missing one after runs
    // means the board is pointed somewhere else.
    const absent = `no progress folder at ${dir}; a member's first run makes it, so if members have run, the board is looking in the wrong place`;
    const empty = wrapNote(note ? `nobody is working right now. ${note}` : (fs.existsSync(dir) ? `no member progress yet in ${dir}` : absent), columns);
    return changeLine ? `${changeLine}\n\n${empty}` : empty;
  }
  // The home folder reads as ~ on screen, so a cd into it does not spend the
  // column on the path; --json keeps the full path for apps.
  const home = os.homedir();
  const homeAt = home && home !== '/' ? new RegExp(`${escapeRe(home)}(?=/|\\s|$)`, 'g') : null;
  const short = (text) => (homeAt ? text.replace(homeAt, '~') : text);
  // A job that opens with its own member's name ("scout continuous run",
  // "scout: map the repo") repeats the member column, so the screen drops it.
  const ownJob = (r) => {
    const rest = r.job.startsWith(`${r.member}: `) ? r.job.slice(r.member.length + 2) : (r.job.startsWith(`${r.member} `) ? r.job.slice(r.member.length + 1) : r.job);
    return rest.trim() ? rest : r.job;
  };
  // A step run through a shell ("/bin/zsh -lc \"git status\"") or after a cd
  // ("cd ~/repo && git status") spends the cell on the wrapper, so the screen
  // shows the command itself; --json keeps the step as written.
  // Fixed status lines the run itself writes, cut to what fits a cell; the
  // rest of each ("onto the workspace", "for this run") is the same every time.
  const RUNNER_LINES = {
    'Landing verified changes onto the workspace.': 'Landing verified changes',
    'Choosing the next useful task.': 'Choosing the next task',
    'Set up an isolated checkout for this run.': 'Set up an isolated checkout',
    'Resuming the saved isolated checkout.': 'Resuming its saved checkout',
  };
  const bareStep = (step) => {
    if (RUNNER_LINES[step]) return RUNNER_LINES[step];
    // "Asked Claude (claude-sonnet-5-5) for help with this step." is the run
    // handing its goal to an engine; the goal is in the job column, so the
    // cell keeps who was asked and the model, without the engine twice.
    const asked = /^Asked (\S+)(?: \(([^)]+)\))? for help with this step\.$/.exec(step);
    if (asked) {
      const [, who, model] = asked;
      const tail = model && model.toLowerCase().startsWith(`${who.toLowerCase()}-`) ? model.slice(who.length + 1) : model;
      return tail ? `Asked ${who} (${tail})` : `Asked ${who}`;
    }
    const m = /^((?:Run|running): )(.*)$/.exec(step);
    if (!m) return step;
    let cmd = m[2];
    const shell = /^(?:\/\S*\/)?(?:zsh|bash|sh) -l?c (["'])(.*)$/.exec(cmd);
    if (shell) {
      const [, q, body] = shell;
      cmd = body.endsWith(q) ? body.slice(0, -1) : body;
      if (q === '"') cmd = cmd.replace(/\\"/g, '"');
    }
    const cd = /^cd (?:"[^"]*"|'[^']*'|\S+) *(?:&&|;) *(.+)$/.exec(cmd);
    if (cd) cmd = cd[1];
    // A heredoc's body is on lines the step never shows, so its opener
    // ("python3 - <<'PY'", "cat >> notes.md <<'EOF'") says what kind of
    // work it is in words instead.
    const doc = /^(.*?) *<<-? *(['"]?)[A-Za-z_]+\2 *$/.exec(cmd);
    if (doc) {
      const into = /^cat (>>?) *(\S+)$/.exec(doc[1]);
      const script = /^(python3?|node|bash|sh|ruby|perl)(?: -)?$/.exec(doc[1]);
      if (into) cmd = `${into[1] === '>>' ? 'append to' : 'write'} ${into[2]}`;
      else if (script) cmd = `${script[1]} script`;
    }
    return cmd.trim() ? m[1] + cmd : step;
  };
  const cells = rows.map((r) => [
    r.member,
    r.state,
    // A history that ended ok every time reads as one "ok", so a failed or
    // stopped run among the earlier ones stands out down the column.
    r.before.length && r.before.every((o) => o === 'ok') ? 'ok' : (r.before.join(' ') || '-'),
    // "no" only ever sits beside a state that already says the run ended
    // (done, stopped, died), so the cell says "yes" or nothing.
    r.alive ? 'yes' : '-',
    r.engine || '-',
    // A died or put-away run's length stops at its last line; it may have run on after.
    r.running_for || (r.lasted && r.lasted_at_least ? `at least ${r.lasted}` : r.lasted) || '-',
    r.ago,
    short(/^continuous run$/i.test(ownJob(r)) && r.working_on ? r.working_on : ownJob(r)) || '-',
    short(bareStep(r.step || '')) || '-',
  ]);
  // Two or more endings in a cell read either way, so the header says
  // which end is the newest run.
  const order = cells.some((c) => c[2].includes(' ')) ? ', newest first' : '';
  const fullHead = ['member', 'state', `before${order}`, 'alive', 'engine', 'run time', 'ago', 'job', 'last step'];
  // before, alive, engine and run time leave the screen when every row says
  // "-": runs started without a pid or engine tag would fill two columns
  // with nothing, and job and last step get the room instead.
  const optional = [2, 3, 4, 5];
  const keep = fullHead.map((_, i) => !optional.includes(i) || cells.some((c) => c[i] !== '-'));
  // A screen too narrow for every column before job gives up room in this
  // order, one step at a time, until the job has JOB_ROOM:
  const shrink = [
    // A before column that says ok on every row tells no row apart from
    // another, so it is the first thing a narrow screen gives up.
    () => { if (cells.every((c) => c[2] === 'ok' || c[2] === '-')) keep[2] = false; },
    // The order words, wider than most before cells; when a cell is as wide,
    // dropping them frees nothing, so they stay.
    () => { if (Math.max(...cells.map((c) => c[2].length)) < fullHead[2].length) fullHead[2] = 'before'; },
    () => { keep[4] = false; }, // engine
    () => { keep[3] = false; }, // alive: state already says when a run died
    () => { for (const c of cells) c[6] = c[6].replace(/ ago$/, ''); }, // the ago word: the header says it
    () => { for (const c of cells) if (c[1] === 'done failed') c[1] = 'failed'; }, // "failed" still says it ended badly
    () => { for (const c of cells) c[5] = c[5].replace(/^at least (\S+)$/, '$1+'); }, // "1h+" still says the run went on past its last line
    () => { fullHead[5] = 'run'; }, // the run time header, wider than "20s" or "1h+"
    () => { for (const c of cells) c[2] = c[2].split(' ')[0]; fullHead[2] = 'before'; }, // before: the newest earlier run is the one that matters, and one word has no order
    () => { keep[2] = false; }, // before: history, where state is now
  ];
  const leftOfJob = () => fullHead.slice(0, -2).reduce((sum, h, i) => (keep[i] ? sum + Math.max(h.length, ...cells.map((c) => c[i].length)) + 2 : sum), 2);
  if (Number.isInteger(columns) && columns > 0) for (const step of shrink) if (columns - leftOfJob() + 2 < JOB_ROOM) step();
  // Past that floor, an all-ok before column still costs words: when job and
  // last step would not both fit whole, it gives them its room.
  const textNeed = [7, 8].reduce((sum, i) => sum + Math.max(fullHead[i].length, ...cells.map((c) => c[i].length)), 0);
  if (Number.isInteger(columns) && columns > 0 && columns - leftOfJob() < textNeed) shrink[0]();
  // A row's last step on its own line doubles the board's height. Before
  // that, the first two steps above go too (an all-ok before column, the
  // order words), but only if together they keep job and last step side by
  // side; otherwise nothing is given up. Engine and alive still name
  // something, so they stay.
  const stacks = () => columns - leftOfJob() < JOB_ROOM + MIN_WIDTH;
  if (Number.isInteger(columns) && columns > 0 && stacks()) {
    const was = [[...keep], [...fullHead]];
    for (const step of shrink.slice(0, 2)) if (stacks()) step();
    if (stacks()) { keep.splice(0, keep.length, ...was[0]); fullHead.splice(0, fullHead.length, ...was[1]); }
  }
  const head = fullHead.filter((_, i) => keep[i]);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].filter((_, i) => keep[i]);
  const [jobAt, stepAt] = [head.length - 2, head.length - 1];
  const fit = (i) => Math.max(head[i].length, ...cells.map((c) => c[i].length));
  const fixed = head.slice(0, -2).reduce((sum, _, i) => sum + fit(i) + 2, 0) + 2;
  // Too narrow for job and last step side by side: the step goes on its
  // own line under its row, and job gets the room the step column had.
  const STEP_LABEL = '  last step: ';
  const stacked = Number.isInteger(columns) && columns > 0 && columns - fixed < JOB_ROOM + MIN_WIDTH;
  const steps = stacked ? cells.map((c) => c.pop()) : [];
  if (stacked) {
    head.pop();
    for (const c of cells) c[jobAt] = cut(c[jobAt], Math.max(STACKED_JOB_MIN, columns - fixed + 2));
  } else {
    const [jobWidth, stepWidth] = textWidths(columns, fixed, fit(jobAt), fit(stepAt));
    for (const c of cells) { c[jobAt] = cut(c[jobAt], jobWidth); c[stepAt] = cut(c[stepAt], stepWidth); }
  }
  const widths = head.map((h, i) => fit(i));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [teamSummary(rows, columns)];
  if (changeLine) out.push(changeLine);
  out.push('', line(head));
  // lean leaves off the step line of a run that has ended, whose last step
  // is history; a live run's step is what it is doing now.
  const blocksFor = (lean) => cells.map((c, k) => [
    line(c),
    ...(stacked && steps[k] !== '-' && !(lean && !['working', 'quiet'].includes(rows[k].state))
      ? [`${STEP_LABEL}${cut(steps[k], Math.max(MIN_WIDTH, columns - STEP_LABEL.length))}`] : []),
  ]);
  let blocks = blocksFor(false);
  const unchecked = uncheckedCount(rows);
  const blind = unchecked
    ? `${unchecked} unfinished run${unchecked === 1 ? '' : 's'} recorded no process id, so a crash there shows as working or quiet, not died`
    : '';
  // The one-line forms below stand in for notes that wrap, only when the
  // board is too tall, so a note's second line never costs a member its row.
  const blindShort = unchecked ? `${unchecked} unfinished run${unchecked === 1 ? ' has' : 's have'} no process id, so a crash there will not show as died` : '';
  const silent = rows.filter((r) => r.likely_ended).map((r) => r.member);
  const gone = silent.length
    ? `${silent.join(', ')} ${silent.length === 1 ? 'has' : 'have'} logged nothing for over an hour with no process id to check, so ${silent.length === 1 ? 'it' : 'they'} most likely ended without saying so`
    : '';
  const goneShort = silent.length ? `${silent.join(', ')} logged nothing for over an hour and ${silent.length === 1 ? 'has' : 'have'} no process id, so likely ended` : '';
  // "replaced" is the board admitting it cannot tell how a run ended; say so.
  // A change note keeps the word for a minute after the column may have
  // learned the run died, so a note that uses it counts too.
  const cutOff = [...new Set([
    ...rows.filter((r) => r.before.includes('replaced')).map((r) => r.member),
    ...changes.filter((c) => c.includes(' -> replaced')).map((c) => c.split(' ')[0]),
  ])];
  const replaced = cutOff.length ? `replaced (${cutOff.join(', ')}): the next run started before that run said how it ended` : '';
  const twice = rows.filter((r) => (r.earlier_alive || []).length).map((r) => `${r.member} (pid ${r.earlier_alive.join(', ')})`);
  // A plain stop signals only the pid on the newest started line; --pid reaches these.
  const still = twice.length ? `still running from an earlier run: ${twice.join(', ')}; atris member stop <name> ends only the newest run, add --pid <pid> for an older one` : '';
  // A board taller than its screen would push the count line and header out
  // of view: rows past the bottom are left off (trouble sorts first, so it
  // stays) and a note says how many, naming as many as fit on one line and
  // counting the rest. Live runs are named first: a run that went quiet
  // sorts below newer finished ones but is the one still worth a look. At
  // least one row always shows.
  const leftOff = (k) => {
    const left = blocks.length - k;
    if (!left) return '';
    const count = `${left} more member${left === 1 ? '' : 's'} did not fit`;
    const live = (r) => (['working', 'quiet'].includes(r.state) ? 0 : 1);
    const names = rows.slice(k).sort((a, b) => live(a) - live(b)).map((r) => r.member);
    const named = `${count}: ${names.join(', ')}`;
    if (!Number.isInteger(columns) || columns <= 0 || named.length <= columns) return named;
    for (let n = names.length - 1; n > 0; n--) {
      const rest = left - n;
      const some = `${count}: ${names.slice(0, n).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
      if (some.length <= columns) return some;
    }
    return count;
  };
  let terse = false;
  const brief = (long, short) => (terse && wrapNote(long, columns).includes('\n') ? short : long);
  const board = (k, tight = false) => {
    const notes = [brief(blind, blindShort), brief(gone, goneShort), replaced, still, note, leftOff(k)].filter(Boolean).map((n) => wrapNote(n, columns));
    const lines = [...out, ...blocks.slice(0, k).flat(), ...(notes.length ? ['', ...notes] : [])];
    return (tight ? lines.filter((l) => l !== '') : lines).join('\n');
  };
  if (!Number.isInteger(height) || height <= 0) return board(blocks.length);
  const tall = (text) => text.split('\n').length > height;
  // A member left off the screen costs more than an ended run's last step.
  if (tall(board(blocks.length))) blocks = blocksFor(true);
  terse = tall(board(blocks.length));
  const rowsThatFit = (tight) => { let k = blocks.length; while (k > 1 && tall(board(k, tight))) k--; return k; };
  // Too short for even one row with the blank lines in: they go first, so
  // the count line stays on screen.
  const tight = tall(board(rowsThatFit(false)));
  return board(rowsThatFit(tight), tight);
}

// Without a pid the board cannot check the process, so a crash in one of
// these runs keeps reading working or quiet instead of died.
function uncheckedCount(rows) {
  return rows.filter((r) => ['working', 'quiet'].includes(r.state) && r.pid === null).length;
}

// Live stream format for `atris member board --json --follow`, one JSON
// object per line on stdout, forever:
//   first line: {"kind":"snapshot","at":"<iso>","dir":"<progress dir>","dir_exists":true,"members":[<same rows as --json>],"counts":{...},"hidden":<n>,"unchecked":<n>}
//   ("dir_exists" is false when the folder is not there yet: no member has run, or the board looks in the wrong place)
//   (each row's "last_active" is the time of its last line, an iso string; "at" is the same moment in ms)
//   ("counts" has every state as a key, "died" through "done ok", counting the members shown, zeros included)
//   ("hidden" counts members that ended over an hour ago and were left out; 0 with --all)
//   ("unchecked" counts unfinished runs shown that recorded no process id, so a crash there reads working or quiet, not died)
//   (each row's "before" lists how its earlier runs ended, newest first, up to 3: "ok", "failed", "stopped", "died", "replaced";
//   "died" means the run had a process id and that process is gone, "replaced" means the next run started before
//   that one said how it ended, so the board cannot tell whether it crashed;
//   "before_started" gives when each of those runs started, same order, as iso strings;
//   "earlier_runs" counts every earlier run in the log, or is null when the log is too long to read whole)
//   then one line per new progress line, in the order it was read:
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"started","text":"<job>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"step","text":"<step>"}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"finished","text":"ok","ok":true}
//     {"member":"builder","mission":"m-1","at":"<iso>","kind":"finished","text":"stopped","ok":false,"stopped":true}
//   (a stop that ended an earlier run still going, by its pid, adds "pid":4242 and "earlier":true;
//   the member's newest run is untouched, and that earlier run gets no died line)
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
//   (a run whose started-line "before" was "replaced" gets a died line too if its process goes away later,
//   a few seconds after, so a stop's line has time to land first)
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
      const pid = earlierStopPid(m[3]);
      if (pid !== null) Object.assign(event, { text: 'stopped', pid, earlier: true });
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

// ready() runs once each file's end is marked and before the first scan,
// so a snapshot taken there cannot lose a line: one written while it is
// taken is sent as an event, at worst also showing in the snapshot.
function followBoard({ dir = progressDir(), emit, pollMs = 1000, orderByTime = false, ready = () => {} } = {}) {
  const offsets = new Map();
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return null; } };
  const list = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { return []; } };
  for (const f of list()) offsets.set(f, afterLastNewline(path.join(dir, f)));
  ready();

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

// With pid, stops that run: the newest one, or an earlier one still going.
async function stopMember(name, { pid: target = null, dir = progressDir(), graceMs = 10000, pollMs = 100, now = () => Date.now(), deps = {} } = {}) {
  const nothing = { ok: false, message: 'nothing running' };
  const member = String(name || '').trim();
  // No name, or a flag typed where the name goes.
  if (!member || member.startsWith('-')) return { ok: false, mistake: true, message: 'say which member to stop, like: atris member stop builder' };
  // A typo is not a member with nothing running, so say there is no such log.
  const unknown = { ok: false, mistake: true, message: `no progress log for ${member} in ${dir}, so there is nothing to stop; atris member board lists who has one` };
  if (!/^[A-Za-z0-9._-]+$/.test(member)) return unknown;
  const file = path.join(dir, `${member}.log`);
  if (!fs.existsSync(file)) return unknown;
  let text = '';
  try { text = readTail(file); } catch { return nothing; }
  const current = currentRun(text);
  if (target !== null && (!current || current.meta.pid !== target)) {
    return stopEarlierRun(member, file, text, target, { graceMs, pollMs, now, deps });
  }
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
  const forced = await endRun(pid, engine, current.startedLine.at, member, run, { graceMs, pollMs, now, deps });
  if (forced === null) return nothing;

  const mission = current.startedLine.mission || '-';
  try { fs.appendFileSync(file, `${new Date().toISOString()} ${mission} finished: stopped\n`, 'utf8'); } catch {}
  const how = forced ? ', it had to be forced' : '';
  return { ok: true, pid, forced, message: `stopped ${member} after ${span(now() - current.startedLine.at)} of work${how}` };
}

// Ends one run's process group: SIGTERM, then SIGKILL after the grace time.
// Returns whether it had to be forced, or null when the pid is not that run.
async function endRun(pid, engine, startedLineAt, member, run, { graceMs, pollMs, now, deps }) {
  if (!runAlive(pid)) return null;
  // A pid from a run that died without a finished line can be reused by an
  // unrelated program; only signal it while its command is still the engine.
  const identity = pidRunsEngine(pid, engine, deps, startedLineAt, member, run);
  if (!identity) return null;
  signalRun(pid, 'SIGTERM');
  const deadline = now() + graceMs;
  // Poll on timers, not a busy loop, so a test parent can reap its child.
  while (runAlive(pid) && now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  // Before the hard kill, the process must be the very same one: same start
  // time and same command, token included, since the pid may have been reused.
  const again = runAlive(pid) && pidRunsEngine(pid, engine, deps, startedLineAt, member, run);
  const forced = Boolean(again) && again.startedAt === identity.startedAt && again.command === identity.command;
  if (forced) signalRun(pid, 'SIGKILL');
  return forced;
}

// An earlier run that never said how it ended and is still going, found by
// its pid. It gets the same identity checks as the newest run, and its stop
// line carries the pid so the board files it under that run.
async function stopEarlierRun(member, file, text, target, opts) {
  const nothing = { ok: false, message: 'nothing running' };
  const found = [...earlierRuns(text)].reverse().find((r) => r.pid === target);
  if (!found || found.done.length) return nothing;
  const forced = await endRun(target, found.engine, found.at, member, found.run, opts);
  if (forced === null) return nothing;
  try { fs.appendFileSync(file, `${new Date().toISOString()} ${found.mission || '-'} finished: stopped [pid ${target}]\n`, 'utf8'); } catch {}
  const how = forced ? ', it had to be forced' : '';
  return { ok: true, pid: target, forced, message: `stopped ${member}'s earlier run (pid ${target}) after ${span(opts.now() - found.at)} of work${how}` };
}

async function memberStopCommand(name, ...rest) {
  const at = rest.indexOf('--pid');
  let pid = null;
  if (at !== -1) {
    pid = Number(rest[at + 1]);
    if (!Number.isInteger(pid) || pid <= 1) {
      console.log('--pid needs the process id from the board, like --pid 4242');
      process.exitCode = 1;
      return;
    }
  }
  const result = await stopMember(name, { pid });
  console.log(result.message);
  // Nothing running is a fine answer; a missing or unknown name is a mistake.
  if (result.mistake) process.exitCode = 1;
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
// One whose process still lived then was replaced, not died; it stays
// watched, and is reported if its process goes away later, unless a stop
// ended it: ended(member, mission, pid) says so from the member's log.
function watchCrashes(rows, emit, read, previous = () => null, alive = isAlive, ended = () => false) {
  const key = (r) => `${r.member} ${r.mission} ${r.pid}`;
  const seen = new Set(rows.filter((r) => r.state === 'died').map(key));
  const open = new Map();
  const replaced = new Map();
  const waited = new Set();
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
        if (p && key(p) === was) {
          if (p.state === 'died' && !ended(p.member, p.mission, p.pid)) report(p);
          else replaced.set(was, p);
        }
      }
      report(r);
      track(r);
    }
    for (const [k, p] of replaced) {
      if (alive(p.pid)) continue;
      const stopped = ended(p.member, p.mission, p.pid);
      // A stop writes its line just after the process exits, so a run with
      // no stop line yet gets one more check before it is called died.
      if (!stopped && !waited.has(k)) { waited.add(k); continue; }
      replaced.delete(k);
      waited.delete(k);
      if (stopped) continue;
      // Its length runs to its last line, as for any crash; '' if it logged nothing past its start.
      const lasted = p.last_active !== p.started_at ? span(Date.parse(p.last_active) - Date.parse(p.started_at)) : '';
      report({ ...p, state: 'died', lasted });
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
    // Only a started or finished line can change how many unfinished runs
    // lack a pid, so only those recount, and only a change is written.
    let unchecked = 0;
    let checkCrashes = () => {};
    // A crash writes no line, so the stream checks pids on its own.
    const previous = (member) => {
      try { return previousRun(member, readTail(path.join(dir, `${member}.log`))); } catch { return null; }
    };
    const ended = (member, mission, pid) => {
      try { return stoppedEarlier(readTail(path.join(dir, `${member}.log`)), mission, pid); } catch { return false; }
    };
    const send = (event) => {
      if (event.kind !== 'started' && event.kind !== 'finished') { write(event); return; }
      // A start can replace a run that just died; name that crash first, so
      // an app reading in order never sees the new run before it.
      if (event.kind === 'started') checkCrashes();
      const rows = readBoard({ dir, all: true });
      // A stop that put away a silent run is not a fresh finish: say so, and
      // when the run last did anything.
      const row = event.stopped && !event.earlier && rows.find((r) => r.member === event.member && r.mission === event.mission);
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
    // The snapshot is read after the stream marks where each file ends, so a
    // line written in between is sent rather than lost.
    const follower = followBoard({ dir, emit: send, ready: () => {
      const view = boardView({ dir, all });
      write({ kind: 'snapshot', at: new Date().toISOString(), dir, dir_exists: fs.existsSync(dir), ...view });
      unchecked = view.unchecked;
      checkCrashes = watchCrashes(view.members, write, () => readBoard({ dir, all: true }), previous, isAlive, ended);
    } });
    const crashes = setInterval(() => checkCrashes(), 2000);
    // Runs until ctrl-c or the reader closes the pipe.
    return new Promise((resolve) => {
      const done = () => { clearInterval(crashes); follower.stop(); resolve(); };
      process.once('SIGINT', done);
      process.stdout.once('error', done);
    });
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: true, dir: progressDir(), dir_exists: fs.existsSync(progressDir()), ...boardView({ all }) }, null, 2));
    return;
  }
  // Only --watch redraws, so only it ever sees a change.
  const changed = changeTracker();
  // Piped output has no size to measure, so it keeps the fixed cut unless
  // COLUMNS (and, for --watch, LINES) names one, for scripts and split panes
  // that want a small board. Read on every draw, so a resized terminal
  // redraws to its new size.
  const measure = (tty, name) => {
    const asked = Number(process.env[name]);
    return process.stdout.isTTY ? process.stdout[tty] : (Number.isInteger(asked) && asked > 0 ? asked : null);
  };
  const width = () => measure('columns', 'COLUMNS');
  const draw = (columns = width(), height = null) => {
    const every = readBoard({ all: true });
    const { members, hidden } = boardView({ all, every });
    return renderBoard(members, progressDir(), hidden, columns, changed(every), height);
  };
  if (!args.includes('--watch')) {
    console.log(draw());
    return;
  }
  // The clock time in the footer moves on every redraw, so a frozen
  // terminal shows an old time instead of looking live. The footer breaks
  // between words like the board's other notes. Only the first draw clears
  // the screen; later ones write over it from the top, erasing what each
  // line leaves behind and anything below, so no blank frame shows between
  // a clear and the redraw.
  let first = true;
  const redraw = () => {
    const columns = width();
    const footer = wrapNote(`redrawn at ${new Date().toTimeString().slice(0, 8)}, redraws every 3s, ctrl-c to stop`, columns);
    // The blank line above the footer, the footer and the last newline take
    // rows too; the board gets the rest.
    const lines = measure('rows', 'LINES');
    const screen = `${draw(columns, lines && lines - footer.split('\n').length - 2)}\n\n${footer}`.split('\n').map((l) => `${l}\x1b[K`).join('\n');
    process.stdout.write(`${first ? '\x1b[2J' : ''}\x1b[H${screen}\n\x1b[J`);
    first = false;
  };
  redraw();
  // The member route exits once this settles, so only settle on ctrl-c.
  return new Promise((resolve) => {
    const timer = setInterval(redraw, 3000);
    process.once('SIGINT', () => { clearInterval(timer); resolve(); });
  });
}

module.exports = {
  readBoard, renderBoard, changeTracker, memberRow, ago, progressEvent, followBoard, memberBoardCommand,
  parseStarted, isAlive, stopMember, memberStopCommand, watchCrashes, previousRun, stoppedEarlier, ENDED_AS,
};

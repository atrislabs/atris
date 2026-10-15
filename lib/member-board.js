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
// Reasons the runner writes that say "failed" by themselves. A stop is left
// out so a failed run never reads like one stopped by hand.
const FAILURE_WORDS = /^(?:timed out|signed out|engine error|bad exit -?\d+|killed by \S+)$/;
// The least room a cut name keeps beside a result column: five letters and
// "...", enough to tell "chat-..." from "build...".
const NAME_ROOM = 8;

function progressDir() {
  return process.env.ATRIS_PROGRESS_DIR || path.join(os.homedir(), '.atris', 'progress');
}

// upTo stops the read at a byte position, so a snapshot can end exactly
// where a live follower starts.
function readTail(file, upTo = Infinity) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = Math.min(fs.fstatSync(fd).size, upTo);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const raw = buf.toString('utf8');
    // A writer may still be finishing the last line; snapshots wait too.
    const text = raw.slice(0, raw.lastIndexOf('\n') + 1);
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

// Terminal cells one character takes: Chinese, Japanese, Korean, and emoji
// take two, joiners and accents take none. Counting letters instead lets a
// job in Chinese wrap past the window and push the header off screen.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;
function charCols(ch) { return ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1; }
function cols(text) {
  let n = 0;
  for (const ch of String(text)) n += charCols(ch);
  return n;
}

function cut(text, width) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (cols(s) <= width) return s;
  let kept = '';
  let n = 0;
  for (const ch of s) {
    if (n + charCols(ch) > width - 3) break;
    kept += ch;
    n += charCols(ch);
  }
  return `${kept}...`;
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
  const engine = began === null ? '' : parseStarted(lines[start].text).engine;
  return { result: m[1] || 'done', reason: failReason(m[1], m[2]), ran: began === null ? '' : span(line.at - began), at: line.at, engine };
}

// What the board says about a failure: the written reason, or, when the
// runner wrote none, how long the run lasted, so "after 2s" (it never got
// going) reads apart from "after 30m" (it ran long).
function whyFailed(r) {
  if (r.last_result_reason) return r.last_result_reason;
  return r.last_result === 'failed' && r.last_result_ran ? `after ${r.last_result_ran}` : '';
}

// A row whose own run failed because the engine is signed out.
function signedOut(r) {
  return r.state === 'done failed' && r.last_result_reason === 'signed out';
}

// A busy member whose earlier run signed out, now running on that same
// engine: signing in fixed it, so its reason no longer reads as news.
function signInFixed(r) {
  const busy = r.state === 'working' || r.state === 'quiet' || r.state === 'asleep after this run';
  return busy && r.last_result_reason === 'signed out' && !!r.last_result_engine && r.last_result_engine === r.engine;
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
  // The process is gone and no finished line came: it ended without saying
  // how. The state word stays "stopped" for scripts; the board says so.
  else if (alive === false) state = 'stopped';
  else state = now - last.at < QUIET_AFTER_MS ? 'working' : 'quiet';
  const result = lastResult(text);
  return {
    member: name,
    state,
    last_result: result ? result.result : '',
    last_result_reason: result ? result.reason : '',
    last_result_ran: result ? result.ran : '',
    last_result_engine: result ? result.engine : '',
    last_result_ago: result ? ago(now - result.at) : '',
    no_result: !stopped && !finished && alive === false,
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
    member, state: 'asleep', last_result: '', last_result_reason: '', last_result_ran: '', last_result_engine: '', last_result_ago: '', no_result: false, asleep: true, pid: null, engine: '', alive: null,
    running_for: '', job: '', step: '', ago: '-', at: 0, idle: false,
  };
}

// The progress folder is shared by every project on this computer. `only`
// names the members to show; null shows every log.
// upTo maps a log file to the byte position the board reads up to; a log
// missing from it counts as empty.
function readBoard({ dir = progressDir(), now = Date.now(), all = false, asleep = [], only = null, upTo = null } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch {}
  if (only) files = files.filter((f) => only.includes(f.slice(0, -'.log'.length)));
  const sleeping = new Set(asleep);
  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = readTail(path.join(dir, f), upTo ? upTo.get(f) || 0 : Infinity); } catch { continue; }
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
// the terminal; each keeps at least its header. width 0 never trims. With
// last step gone (lastStep false), the job alone takes what is left.
const MIN_TEXT_WIDTH = 9;
const OPTIONAL_COLUMNS = Object.freeze(['alive', 'engine', 'running for']);

function fitText(cells, widths, width, lastStep = true, live = new Set()) {
  if (!width) return;
  const [job, step] = [widths.length - 2, widths.length - 1];
  if (!lastStep) {
    const before = widths.slice(0, step).reduce((n, w) => n + w + 2, 0);
    const jobW = Math.max(MIN_TEXT_WIDTH, width - before);
    for (const c of cells) c[step] = cut(c[step], jobW);
    widths[step] = Math.min(widths[step], jobW);
    return;
  }
  const prefix = widths.slice(0, job).reduce((n, w) => n + w + 2, 0);
  const room = width - prefix - 2;
  if (widths[job] + widths[step] <= room) return;
  // The job says what the run is for, so it reads whole whenever the last
  // step still keeps its heading's width; otherwise they split the room.
  // A job already cut to its usual 50 cannot read whole, so it splits too.
  // A live run's step says what it is doing now, so the job never cuts it.
  const whole = cells.every((c) => !c[job].endsWith('...'));
  const spared = cells.every((c, k) => !live.has(k) || cols(c[step]) <= room - widths[job]);
  const jobW = whole && spared && room - widths[job] >= MIN_TEXT_WIDTH ? widths[job]
    : Math.max(MIN_TEXT_WIDTH, Math.min(widths[job], Math.max(Math.floor(room / 2), room - widths[step])));
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
  if (!rows.length) {
    if (note) return [
      `nobody is working right now. ${note}`,
      `nobody is working. ${hidden} older runs hidden. --all shows them`,
      `nobody is working. ${hidden} older runs hidden`,
      `idle. ${hidden} older runs hidden`,
      `idle. ${hidden} older`,
      'idle', '-',
    ].find((text) => !width || text.length <= width) || '';
    const prefix = 'no member progress yet in ';
    const message = `${prefix}${dir}`;
    if (!width || cols(message) <= width) return message;
    if (width >= prefix.length + 4) return cut(message, width);
    return ['no member progress yet', 'no progress yet', 'no progress', 'empty', '-']
      .find((text) => text.length <= width) || '';
  }
  // Older runs never push a current member off the screen: their note only
  // takes rows the board does not need. A cut board puts its footer right
  // under the last member, so the blank line never costs a member a row.
  const fits = height && rows.length + 1 > height ? Math.max(0, height - 2) : rows.length;
  const short = rows.length - fits;
  // A failure, or a run that died with no result, is news, so it takes a row
  // first; a stop someone asked for comes next, since they already know.
  const urgent = (r) => (r.state === 'done failed' || (r.state === 'stopped' && r.no_result) ? 2 : r.state === 'stopped' ? 1 : 0);
  const picked = new Set(rows.map((r, i) => i).sort((a, b) => urgent(rows[b]) - urgent(rows[a]) || a - b).slice(0, fits));
  const left = rows.filter((_, i) => !picked.has(i));
  // A run that died with no result counts apart from one stopped on purpose.
  // Hidden failures that all wrote the same reason say it once, so one fix
  // for all of them shows: "3 failed, all signed out", or "1 failed, timed out".
  // Mixed, a reason that two or more share and no other ties names the
  // biggest fix: "3 failed, 2 signed out". With no lead, two or three
  // reasons that every failure wrote are each named rather than none:
  // "2 failed, timed out and engine error". Signed out leads that list, as
  // the one a person must fix: "signed out, bad exit 2 and timed out".
  const sharedReason = (failed) => {
    const why = [...new Set(failed.map((r) => r.last_result_reason))];
    const most = why.filter(Boolean).map((w) => [failed.filter((r) => r.last_result_reason === w).length, w]).sort((a, b) => b[0] - a[0]);
    const lead = most.length && most[0][0] > 1 && (most.length === 1 || most[0][0] > most[1][0]) ? `${most[0][0]} ${most[0][1]}` : '';
    const each = [...most].sort((x, y) => (y[1] === 'signed out') - (x[1] === 'signed out'))
      .map(([n, w]) => (most.some(([k]) => k > 1) ? `${n} ${w}` : w));
    const every = !lead && why.every(Boolean) && each.length > 1 && each.length <= 3 ? `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}` : '';
    return why.length === 1 && why[0] ? `${failed.length > 1 ? 'all ' : ''}${why[0]}` : lead || every;
  };
  let shared = sharedReason(left.filter((r) => r.state === 'done failed'));
  // Hidden failures all signed out of one engine get the fix their rows
  // give, "sign in to claude", wherever that wording changes nothing else.
  // In a mix, the signed out ones name their engine the same way:
  // "3 failed, 2 signed out of claude".
  const signedOutOf = [...new Set(left.filter((r) => r.state === 'done failed').map((r) => (signedOut(r) ? r.engine : '')))];
  const outOf = [...new Set(left.filter(signedOut).map((r) => r.engine))];
  let fix = signedOutOf.length === 1 && signedOutOf[0] ? `sign in to ${signedOutOf[0]}`
    : outOf.length === 1 && outOf[0] && /\bsigned out\b/.test(shared) ? shared.replace(/\bsigned out\b/, `signed out of ${outOf[0]}`) : '';
  const busy = left.filter((r) => r.state === 'working' || r.state === 'quiet' || r.state === 'asleep after this run');
  const earlier = busy.filter((r) => r.last_result === 'failed');
  // Up to three runs still going are worth their names, not a silent share
  // of the total: "3 more not shown (1 failed, builder working, scout quiet)".
  // Names only take room from wording, never from a failure count or reason
  // (below), and all of them show or none do, so no live run looks missing.
  // Too many or too long, they become one count instead: "2 running".
  const lone = busy.filter((r) => !earlier.includes(r));
  const live = {
    names: lone.length <= 3 ? lone.map((r) => `${r.member} ${r.state.replace('asleep after this run', 'finishing')}`) : [],
    count: lone.length ? [`${lone.length} running`] : [],
  };
  let earlierWhy = sharedReason(earlier.map((r) => (signInFixed(r) ? { ...r, last_result_reason: '' } : r)));
  // A member now on another engine still names the one it signed out of:
  // "1 with earlier failure, signed out of claude".
  const earlierOut = [...new Set(earlier.filter((r) => r.last_result_reason === 'signed out' && !signInFixed(r)).map((r) => r.last_result_engine || ''))];
  const earlierFix = earlierOut.length === 1 && earlierOut[0] && /\bsigned out\b/.test(earlierWhy)
    ? earlierWhy.replace(/\bsigned out\b/, `signed out of ${earlierOut[0]}`) : '';
  const counts = (withWhy, compact = false, how = '') => [
    [withWhy && shared ? `failed, ${compact ? shared.replace(/^all /, '') : shared}` : 'failed', (r) => r.state === 'done failed'],
    ['stopped', (r) => r.state === 'stopped' && !r.no_result],
    [compact ? 'no result' : 'ended with no result', (r) => r.state === 'stopped' && r.no_result],
    [`${compact ? '' : 'with '}earlier failure${withWhy === true && earlierWhy ? `, ${compact ? earlierWhy.replace(/^all /, '') : earlierWhy}` : ''}`, (r) => earlier.includes(r)],
  ].map(([word, is]) => [left.filter(is).length, word])
    .filter(([n]) => n).map(([n, word]) => `${n} ${word}`).concat(live[how] || []);
  const tally = (withWhy, compact, how) => counts(withWhy, compact, how).join(', ');
  rows = rows.filter((_, i) => picked.has(i));
  const cells = rows.map((r) => [
    r.member,
    r.state,
    r.no_result ? 'ended, no result' : r.last_result ? `${r.last_result}${whyFailed(r) ? ` (${whyFailed(r)})` : ''} ${r.last_result_ago}` : '-',
    r.alive === null ? '-' : (r.alive ? 'yes' : 'no'),
    r.engine || '-',
    r.running_for || '-',
    r.ago,
    r.job || '-',
    // Signed out is the one failure a person must fix, so its last step
    // says how instead of the step the engine never got past.
    signedOut(r) ? `sign in to ${r.engine || 'the engine'}, then run it again` : r.step || '-',
  ]);
  let head = ['member', 'state', 'last result', 'alive', 'engine', 'running for', 'ago', 'job', 'last step'];
  // On a terminal, alive, engine, and running for leave when no row has a
  // value there; old runs without a pid tag fill them with "-" only. If they
  // would still push the board past the window, they fold into one run
  // column that names a live run's engine and age: "claude 2m". With no live
  // run they just leave. A done row's last result is that same run, so there
  // it shrinks to just the reason.
  const measure = (cs) => head.map((h, i) => Math.max(h.length, ...cs.map((c) => cols(c[i]))));
  // A live run guards its last step only once it has one; a lone "-" says
  // nothing, so it never costs a job its room.
  const busyRows = new Set(rows.map((r, k) => (['working', 'quiet', 'asleep after this run'].includes(r.state) && r.step ? k : -1)).filter((k) => k >= 0));
  const locked = rows.map((r, k) => (signedOut(r) ? k : -1)).filter((k) => k >= 0);
  const fixes = [(e) => `sign in to ${e}, then run it again`, (e) => `sign in to ${e}`, () => 'sign in'];
  // How much of a signed out row's fix fits in w columns: 0 is all of it.
  const fixForm = (k, w) => {
    const at = fixes.findIndex((f) => f(rows[k].engine || 'the engine').length <= w);
    return at < 0 ? fixes.length : at;
  };
  // Cheap ways to make room, cheapest first: "failed" for "done failed"
  // (its result says it ended), then "result" for the "last result" heading,
  // then a live run's engine word once its columns fold into one run column.
  const makeRoom = {
    state: () => rows.forEach((r, k) => { cells[k][1] = r.state.replace(/^done /, ''); }),
    heading: () => { head[2] = 'result'; },
    engine: () => {
      const at = head.indexOf('run');
      if (at >= 0) rows.forEach((r, k) => { if (r.alive && r.running_for) cells[k][at] = r.running_for; });
    },
  };
  // The last step cells, kept aside when that column leaves.
  let shelved = null;
  if (width) {
    const shown = head.map((h, i) => !OPTIONAL_COLUMNS.includes(h) || cells.some((c) => c[i] !== '-'));
    // Too narrow: the columns before job, plus job and last step at their
    // smallest, do not fit.
    const before = head.slice(0, 7).reduce((n, h, i) => (shown[i] ? n + 2 + Math.max(h.length, ...cells.map((c) => cols(c[i]))) : n), 0);
    const narrow = before + MIN_TEXT_WIDTH + 2 + MIN_TEXT_WIDTH > width;
    // A stopped row's last result is its own run, like a done row's, so it
    // shrinks the same way: to how it ended, with the age left to "ago".
    const ended = (r) => r.state.startsWith('done ') || (r.state === 'stopped' && !r.no_result);
    const reasonOnly = () => rows.forEach((r, k) => {
      if (ended(r)) cells[k][2] = r.state === 'stopped' ? 'on purpose' : whyFailed(r) || '-';
    });
    if (narrow) reasonOnly();
    const live = rows.map((r) => (r.alive ? `${r.engine || 'live'} ${r.running_for}`.trim() : '-'));
    // Wide but still past the window, a live run folds too: one run column
    // leaves the job and last step more room than three.
    const past = head.reduce((n, h, i) => (shown[i] ? n + 2 + Math.max(h.length, ...cells.map((c) => cols(c[i]))) : n), -2) > width;
    const fold = (narrow || past) && live.some((v) => v !== '-');
    const keep = head.map((h, i) => shown[i] && (!(narrow || past) || !OPTIONAL_COLUMNS.includes(h)));
    head = head.filter((_, i) => keep[i]);
    for (const c of cells) c.splice(0, c.length, ...c.filter((_, i) => keep[i]));
    if (fold) {
      head.splice(3, 0, 'run');
      cells.forEach((c, k) => c.splice(3, 0, live[k]));
    }
    // Wide, but the board still runs past the window: a done row's last
    // result shrinks to the reason here too, so job and last step get the room.
    const total = () => head.reduce((n, h, i) => n + 2 + Math.max(h.length, ...cells.map((c) => cols(c[i]))), -2);
    if (!narrow && total() > width) reasonOnly();
    // A busy row's last result is an earlier run. If it still overflows, it
    // drops "ago", then a reason that says failed on its own keeps just the
    // reason, as the compact board does, then the reason goes:
    // "failed (bad exit 2) 14m" -> "bad exit 2" -> "failed 14m". A fixed
    // sign-in never stands alone, so "signed out" never sits beside "working".
    // Wide, only "ago" goes, since the reason is the one place that run says why.
    const over = () => head.slice(0, -2).reduce((n, h, i) => n + 2 + Math.max(h.length, ...cells.map((c) => cols(c[i]))), 0)
      + MIN_TEXT_WIDTH + 2 + MIN_TEXT_WIDTH > width;
    const earlier = rows.map((r, k) => (r.last_result && !r.no_result && !ended(r) ? k : -1)).filter((k) => k >= 0);
    const shorter = [
      (r) => `${r.last_result}${whyFailed(r) ? ` (${whyFailed(r)})` : ''} ${r.last_result_ago.replace(/ ago$/, '')}`,
      (r) => (FAILURE_WORDS.test(r.last_result_reason || '') && !signInFixed(r) ? r.last_result_reason : `${r.last_result} ${r.last_result_ago.replace(/ ago$/, '')}`),
      (r) => `${r.last_result} ${r.last_result_ago.replace(/ ago$/, '')}`,
    ];
    for (const form of narrow ? shorter : shorter.slice(0, 1)) {
      if (!earlier.length || !(narrow ? over() : total() > width)) break;
      // A form no shorter than the cell frees nothing, so the reason stays.
      for (const k of earlier) if (cols(form(rows[k])) < cols(cells[k][2])) cells[k][2] = form(rows[k]);
    }
    // A live run's step says what it is doing now, so the run column drops
    // its engine word ("codex 3m" -> "3m") when that lets the step read
    // further. A hidden last step comes back with the fewest of these that
    // bring it back with no job any shorter, cheapest first: "failed" for
    // "done failed" (its result says it ended), "result" for the "last result"
    // heading, then the engine word. With no live run, a step that fits only
    // by cutting a job shorter than it reads without it just leaves: a cheap change
    // that brought it back here would undo itself one column wider, and the
    // step would read less there. Nor may it shrink a signed out row's fix
    // below what hiding it leaves, unless the fix still names the engine:
    // "sign in to claude" is the part a person acts on.
    const fit = (step) => {
      const trial = cells.map((c) => (step ? [...c] : c.slice(0, -1)));
      // With no last step, a signed out row's fix takes the job cell.
      if (!step) for (const k of locked) trial[k][trial[k].length - 1] = cells[k][cells[k].length - 1];
      fitText(trial, head.slice(0, step ? head.length : -1).map((h, i) => Math.max(h.length, ...trial.map((c) => c[i].length))), width, step, busyRows);
      return trial;
    };
    const jobsHold = (after, before) => after.every((c, k) => locked.includes(k) || c[c.length - 2] === before[k][before[k].length - 1]);
    const bare = fit(false);
    const hidden = over();
    const fixHold = (after, before) => after.every((c, k) => !locked.includes(k)
      || fixForm(k, c[c.length - 1].length) <= Math.max(1, fixForm(k, before[k][before[k].length - 1].length)));
    // The fix is judged with the cheap changes made ("failed", "result", and
    // a live run's engine word), since they go to it first.
    const roomy = () => {
      const saved = cells.map((c) => [...c]);
      const heading = head[2];
      makeRoom.state();
      makeRoom.heading();
      if (fold) rows.forEach((r, k) => { if (r.alive && r.running_for) cells[k][3] = r.running_for; });
      const trial = fit(true);
      cells.forEach((c, k) => c.splice(0, c.length, ...saved[k]));
      head[2] = heading;
      return trial;
    };
    const withStep = !hidden && fit(true);
    const cuts = Boolean(withStep) && ((!busyRows.size && !jobsHold(withStep, bare)) || (locked.length > 0 && !fixHold(roomy(), bare)));
    let kept = !hidden && !cuts;
    if (!cuts && (fold || hidden)) {
      const steps = (cs) => [...busyRows].reduce((n, k) => n + cs[k][cs[k].length - 1].length, 0);
      const was = cells.map((c) => [...c]);
      const before = hidden ? fit(false) : steps(fit(true));
      // Nor may it leave a signed out row's fix shorter than hiding the step
      // would, once the cheap changes give that fix their room too.
      const fixRoom = hidden && locked.length ? (() => {
        makeRoom.state();
        makeRoom.heading();
        makeRoom.engine();
        const trial = fit(false);
        return new Map(locked.map((k) => [k, trial[k][trial[k].length - 1].length]));
      })() : new Map();
      const shrink = {
        ...makeRoom,
        engine: () => rows.forEach((r, k) => { if (r.alive && r.running_for) cells[k][3] = r.running_for; }),
      };
      const tries = (hidden ? [['state'], ['heading'], ['engine'], ['state', 'heading'], ['state', 'engine'], ['heading', 'engine'], ['state', 'heading', 'engine']] : [['engine']])
        .filter((t) => fold || !t.includes('engine'));
      const undo = () => { head[2] = 'last result'; cells.forEach((c, k) => c.splice(0, c.length, ...was[k])); };
      const tried = tries.find((t) => {
        undo();
        t.forEach((name) => shrink[name]());
        const after = !over() && fit(true);
        return after && (hidden
          ? jobsHold(after, before) && after.every((c, k) => !locked.includes(k) || fixForm(k, c[c.length - 1].length) <= fixForm(k, fixRoom.get(k)))
          : steps(after) > before);
      });
      if (tried) kept = true;
      else undo();
    }
    // Still too wide for job and last step at their smallest, or a finished
    // row's step would cut a job: last step leaves and the job gets the room,
    // since it says what the run is for. A signed out row keeps its fix there instead
    // (below).
    if (!kept) {
      head.pop();
      shelved = cells.map((c) => c.pop());
    }
  }
  let lastStep = head[head.length - 1] === 'last step';
  const jobAt = head.indexOf('job');
  // How much of each job, step, or fix reads once the board is fitted.
  const reads = (cs = cells) => {
    const trial = cs.map((c) => [...c]);
    fitText(trial, measure(trial), width, lastStep, busyRows);
    return trial.map((c) => c.slice(jobAt).map((v) => v.replace(/\.\.\.$/, '').length));
  };
  // A missing result shortens to "no result" only when the room it frees
  // lets every job read whole; a job cut either way keeps the full wording.
  // With every job whole either way, it also shortens when that lets a step
  // read further, so the full wording never cuts a step that one column
  // narrower read more of.
  const jobsWhole = (cs) => {
    const trial = cs.map((c) => [...c]);
    fitText(trial, measure(trial), width, lastStep, busyRows);
    return trial.every((c, k) => c[jobAt] === cs[k][jobAt]);
  };
  const gone = rows.map((r, k) => (r.no_result && cells[k][2] === 'ended, no result' ? k : -1)).filter((k) => k >= 0);
  if (width && jobAt >= 0 && gone.length) {
    const trial = cells.map((c) => [...c]);
    for (const k of gone) trial[k][2] = 'no result';
    const whole = jobsWhole(cells);
    const [full, brief] = [reads(), reads(trial)];
    const further = lastStep && brief.some((r, k) => r[1] > full[k][1]);
    if (jobsWhole(trial) && (!whole || further)) for (const k of gone) cells[k][2] = 'no result';
  }
  // A signed out row's fix gets shorter rather than cut, in whichever cell
  // ends the row: "sign in to claude, then run it again", then
  // "sign in to claude", then "sign in". Before each shorter fix, the cheap
  // ways to make room get a try, so a wider board never says less.
  const fixFits = () => {
    const trial = cells.map((c) => [...c]);
    fitText(trial, measure(trial), width, lastStep, busyRows);
    return locked.every((k) => trial[k][trial[k].length - 1] === cells[k][cells[k].length - 1]);
  };
  fixing: for (const fix of width && locked.length ? fixes : []) {
    for (const k of locked) cells[k][cells[k].length - 1] = fix(rows[k].engine || 'the engine');
    const was = cells.map((c) => [...c]);
    const heading = head[2];
    // The engine word counts here too, as it did when the last step was
    // judged, so "sign in to claude" never turns to "sign in" one column wider.
    for (const ways of [[], ['state'], ['state', 'heading'], ['state', 'heading', 'engine']]) {
      cells.forEach((c, k) => c.splice(0, c.length, ...was[k]));
      head[2] = heading;
      ways.forEach((name) => makeRoom[name]());
      if (fixFits()) {
        // As for a live step, the engine word also goes when that lets a job
        // or step read further and costs no row any of it.
        if (!ways.includes('engine') && head.includes('run')) {
          const kept = cells.map((c) => [...c]);
          const before = reads();
          makeRoom.engine();
          const after = reads();
          const more = after.some((r, k) => r.some((n, i) => n > before[k][i]));
          if (!fixFits() || !more || after.some((r, k) => r.some((n, i) => n < before[k][i]))) cells.forEach((c, k) => c.splice(0, c.length, ...kept[k]));
        }
        break fixing;
      }
    }
    cells.forEach((c, k) => c.splice(0, c.length, ...was[k]));
    head[2] = heading;
  }
  // Once a signed out row is on the board, "done" has already given way for
  // its fix at some width. It comes back only when it costs no row any of its
  // job or last step, so one column wider never reads less.
  if (width && jobAt >= 0 && locked.length && rows.some((r, k) => r.state.startsWith('done ') && cells[k][1] === r.state)) {
    const states = cells.map((c) => c[1]);
    const was = reads();
    makeRoom.state();
    const now = reads();
    const more = now.some((r, k) => r.some((n, i) => n > was[k][i]));
    if (!more || now.some((r, k) => r.some((n, i) => n < was[k][i]))) cells.forEach((c, k) => { c[1] = states[k]; });
  }
  let widths = measure(cells);
  const unfit = cells.map((c) => [...c]);
  fitText(cells, widths, width, lastStep, busyRows);
  // A result column of only "-" says nothing. When the job or last step was
  // cut to fit, it leaves and they get its room. If the last step left
  // instead, it comes back in that room when every job still reads as much
  // as it does alone, so a job never gives up a word for it.
  if (width && jobAt >= 0 && /result$/.test(head[2]) && unfit.every((c) => c[2] === '-')) {
    const cut = cells.some((c, k) => c.slice(jobAt).some((v, i) => v !== unfit[k][jobAt + i]));
    const bare = unfit.map((c) => c.filter((_, i) => i !== 2));
    const laid = (cs, step) => {
      const trial = cs.map((c) => [...c]);
      const heads = [...head.filter((_, i) => i !== 2), ...(step ? ['last step'] : [])];
      const ws = heads.map((h, i) => Math.max(h.length, ...trial.map((c) => cols(c[i]))));
      fitText(trial, ws, width, step, busyRows);
      return ws.reduce((n, w) => n + w + 2, -2) <= width && trial;
    };
    const alone = shelved && shelved.some((v) => v !== '-') && !locked.length && laid(bare, false);
    const beside = alone && laid(bare.map((c, k) => [...c, shelved[k]]), true);
    const back = Boolean(beside) && beside.every((c, k) => c[c.length - 2] === alone[k][alone[k].length - 1]);
    if (cut || back) {
      head.splice(2, 1);
      cells.forEach((c, k) => c.splice(0, c.length, ...bare[k], ...(back ? [shelved[k]] : [])));
      if (back) { head.push('last step'); lastStep = true; }
      widths = measure(cells);
      fitText(cells, widths, width, lastStep, busyRows);
    }
  }
  // Once even the job would wrap, keep the member, state, and result.
  // Compact state words leave room for a whole common failure reason.
  if (width >= 18 && widths.reduce((n, w) => n + w + 2, -2) > width) {
    const state = (r) => r.state.replace(/^done /, '').replace('asleep after this run', 'finishing');
    // With no result column, a run that died says so in its state, so it
    // reads apart from one stopped by hand. A failed run says why instead
    // of "failed" when the runner's reason reads as a failure on its own
    // and fits beside a whole "member" heading: "timed out", "bad exit 2".
    const brief = (r) => {
      const why = r.state === 'done failed' && FAILURE_WORDS.test(r.last_result_reason || '') ? r.last_result_reason : '';
      return r.no_result ? 'no result' : why && cols(why) + 2 + 'member'.length <= width ? why : state(r);
    };
    const twoColumns = () => {
      head = ['member', 'state'];
      rows.forEach((r, k) => { cells[k] = [r.member, brief(r)]; });
      widths = measure(cells);
    };
    if (width < 30) twoColumns();
    else {
      head = ['member', 'state', 'last result'];
      // A stopped row says how, not "stopped" twice: only member stop
      // writes that finish, so it was on purpose.
      rows.forEach((r, k) => {
        const result = r.no_result ? 'ended, no result' : r.state === 'stopped' ? 'on purpose' : (!signInFixed(r) && whyFailed(r)) || r.last_result || '-';
        cells[k] = [r.member, state(r), result];
      });
      widths = measure(cells);
      // Keep the full missing-result wording only when it costs no name a
      // letter the shorter "no result" would leave it.
      const shortW = measure(cells.map((c, k) => (rows[k].no_result ? [c[0], c[1], 'no result'] : c)))[2];
      const names = (w) => Math.min(widths[0], width - widths[1] - w - 4);
      if (NAME_ROOM + widths[1] + 'ended, no result'.length + 4 > width || names(widths[2]) < names(shortW)) {
        rows.forEach((r, k) => { if (r.no_result) cells[k][2] = 'no result'; });
        widths = measure(cells);
      }
      // Names cut to a stub like "b..." cannot tell rows apart. When names
      // keeping their room would cut a failure reason or the heading, use
      // the two-column form, which still says why a run failed. Any other
      // result may be cut. When the result column only repeats what the
      // two-column state says, a name it would cut sends the board there
      // too: "chat-experience..." beats "chat-...", so 30 columns never
      // reads less of a name than 29.
      const whole = Math.max(head[2].length, ...cells.map((c) => (FAILURE_WORDS.test(c[2]) ? cols(c[2]) : 0)));
      const adds = rows.some((r, k) => r.state !== 'stopped' && !['-', brief(r)].includes(cells[k][2]));
      if (widths[0] + widths[1] + widths[2] + 4 > width && (!adds || width - widths[1] - Math.min(NAME_ROOM, widths[0]) - 4 < whole)) twoColumns();
    }
    // Names keep their room, and the result column takes the rest.
    if (head.length === 3) widths[2] = Math.min(widths[2], width - Math.min(NAME_ROOM, widths[0]) - widths[1] - 4);
    widths[0] = Math.min(widths[0], width - widths[1] - (head.length === 3 ? widths[2] + 4 : 2));
    for (const c of cells) {
      c[0] = cut(c[0], widths[0]);
      if (head.length === 3) c[2] = cut(c[2], widths[2]);
    }
  }
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v + ' '.repeat(Math.max(0, widths[i] - cols(v))))).join('  ').trimEnd();
  const out = [line(head)];
  for (const c of cells) out.push(line(c));
  // The footer stays one line: a wrapped footer would push the header off a
  // watch screen sized to fit. Too wide, it drops "the window is too short",
  // then shortens the hidden count, earlier failure label, and "all", then
  // shortens the older-runs note and drops it, then drops a shared reason,
  // the earlier failure's first.
  // Older runs matter less than this screen. Only then do whole counts drop
  // from the end, so none is cut mid-word: "4 hidden (1 failed, ...)", and
  // when not even one count fits, just "4 hidden" rather than "4 hidden (1 fa...".
  // Anything still too wide is cut.
  const notShown = (withWhy, compact = false, tiny = false, how = '') => (short ? `${short} ${tiny ? 'hidden' : 'more not shown'}${tally(withWhy, compact, how) ? ` (${tally(withWhy, compact, how)})` : ''}` : '');
  const older = hidden ? `${hidden} older runs hidden, --all shows them` : '';
  const olderShort = hidden ? [`${hidden} older, --all shows them`, `${hidden} older hidden`, `${hidden} older`] : [];
  // Each form: [with reason, compact labels, "hidden", window is too short, note].
  // A failure reason outranks the older-runs note. The reason for a run that
  // failed earlier goes before the reason for one that is done failed: that
  // member is running again, so "1 failed, timed out, ..., w2 working" beats
  // dropping both reasons to keep the name.
  const shorter = (why) => [
    [why, false, false, false, older],
    [why, true, false, false, older],
    [why, true, true, false, older],
    ...olderShort.map((o) => [why, true, true, false, o]),
    [why, true, true, false, ''],
  ];
  const forms = [
    [true, false, false, true, note],
    [true, false, false, false, note],
    ...shorter(true),
    ...shorter('failed'),
    ...shorter(false),
  ];
  const footerNow = () => {
    const say = ([why, compact, tiny, win, tail], how = '') => [short ? `${notShown(why, compact, tiny, how)}${win ? ', the window is too short' : ''}` : '', tail].filter(Boolean).join('. ');
    const room = (f) => f && (!width || cols(f) <= width);
    const dropped = [
      ...counts(false, true).slice(1).map((_, i, rest) => `${short} hidden (${counts(false, true).slice(0, rest.length - i).join(', ')}, ...)`),
      ...(short && counts(false, true).length ? [`${short} hidden`] : []),
    ];
    const pick = forms.find((f) => room(say(f)));
    // Live names, else their count, fit in by dropping "the window is too
    // short", then shorter labels, then a shorter older-runs note, always at
    // the same counts and reasons.
    const tails = [note, older, ...olderShort, ''];
    const labels = pick ? [[pick[1], pick[2]], [true, pick[2]], [true, true]] : [];
    const roomier = pick ? [...(pick[3] ? [pick] : []), ...tails.slice(Math.max(0, tails.indexOf(pick[4])))
      .flatMap((t) => labels.map(([compact, tiny]) => [pick[0], compact, tiny, false, t]))] : [];
    const withName = short ? ['names', 'count'].flatMap((how) => (live[how].length ? roomier.map((f) => say(f, how)) : [])).find(room) : '';
    const said = [...forms.map((f) => say(f)), ...dropped].filter(Boolean);
    return withName || (pick ? say(pick) : dropped.find(room)) || cut(said[said.length - 1], width);
  };
  let footer = footerNow();
  // A lead reason other than signed out still names the sign-in failures
  // after it, the one a person must fix, wherever that changes nothing
  // else: "3 failed, 2 timed out, 1 signed out".
  const outs = left.filter(signedOut).length;
  if (outs && shared && !/\bsigned out\b/.test(shared)) {
    const was = shared;
    shared = `${was}, ${outs} signed out`;
    const named = footerNow();
    if (named.replace(`, ${outs} signed out`, '') === footer) {
      footer = named;
      if (outOf.length === 1 && outOf[0]) fix = shared.replace(/\bsigned out$/, `signed out of ${outOf[0]}`);
    } else shared = was;
  }
  if (fix) {
    const [plain, was] = [footer, shared];
    shared = fix;
    const named = footerNow();
    if ([was, was.replace(/^all /, '')].some((w) => named.replace(`failed, ${fix}`, `failed, ${w}`) === plain)) footer = named;
    else shared = was;
  }
  if (earlierFix) {
    const [plain, was] = [footer, earlierWhy];
    earlierWhy = earlierFix;
    const named = footerNow();
    const same = (f) => f.split(`signed out of ${earlierOut[0]}`).join('signed out');
    if (same(named) === same(plain)) footer = named;
    else earlierWhy = was;
  }
  if ((note || short) && (!height || out.length < height)) {
    if (!height || out.length + 2 <= height) out.push('');
    out.push(footer);
  }
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

// ready gets each log's starting position before the first scan, so a
// snapshot built from those same bytes neither misses nor repeats a line.
function followBoard({ dir = progressDir(), emit, pollMs = 1000, orderByTime = false, ready } = {}) {
  const offsets = new Map();
  // Check a bounded sample behind the cursor: an in-place rewrite can keep
  // both the inode and size, while an ordinary append leaves these bytes alone.
  const anchorAt = (fd, offset) => {
    const start = Math.max(0, offset - 256);
    const buf = Buffer.alloc(offset - start);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
  };
  const list = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { return []; } };
  for (const f of list()) {
    const file = path.join(dir, f);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const { dev, ino } = fs.fstatSync(fd);
      const offset = afterLastNewline(file);
      offsets.set(f, { dev, ino, offset, anchor: anchorAt(fd, offset) });
    } catch { /* A log may disappear while the follower opens. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  if (ready) ready(new Map([...offsets].map(([f, cursor]) => [f, cursor.offset])));

  function readNew(f, events) {
    const file = path.join(dir, f);
    let fd;
    let buf;
    let cursor;
    let from;
    try {
      fd = fs.openSync(file, 'r');
      const { size, dev, ino } = fs.fstatSync(fd);
      cursor = offsets.get(f);
      // Use the opened file's identity, so an atomic replacement starts at the
      // top even if no scan saw a missing path or a smaller file.
      if (!cursor || cursor.dev !== dev || cursor.ino !== ino) {
        cursor = { dev, ino, offset: 0 };
      }
      const rewritten = cursor.anchor && size >= cursor.offset
        && !cursor.anchor.equals(anchorAt(fd, cursor.offset));
      from = size < cursor.offset || rewritten ? 0 : cursor.offset;
      offsets.set(f, { ...cursor, offset: from });
      if (size === from) return;
      buf = Buffer.alloc(size - from);
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
      const end = buf.lastIndexOf(0x0a);
      if (end >= 0) cursor = { ...cursor, anchor: anchorAt(fd, from + end + 1) };
    } catch { return; } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // Stop at the last newline; a half-written tail waits for the next scan.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    offsets.set(f, { ...cursor, offset: from + end + 1 });
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
    const files = new Set(list());
    // A log that disappeared no longer owns a reading position. Its replacement
    // may be larger than the old log, so a size check alone cannot find it.
    for (const f of offsets.keys()) if (!files.has(f)) offsets.delete(f);
    for (const f of files) readNew(f, events);
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
    // Runs until ctrl-c or the reader closes the pipe. Listen before the
    // first line goes out, so a reader that stops at once still gets exit 0.
    return new Promise((resolve) => {
      let follower = null;
      const done = () => { if (follower) follower.stop(); resolve(); };
      process.once('SIGINT', done);
      process.stdout.once('error', done);
      // The snapshot ends where the follower starts reading. Built first, a
      // line written between the two would show up in neither.
      // Tests poll faster, so a wait that proves nothing more arrives can be
      // short and still span several polls.
      const poll = Number(process.env.ATRIS_FOLLOW_POLL_MS);
      follower = followBoard({
        dir,
        pollMs: poll >= 10 ? poll : undefined,
        ready: (upTo) => write({ kind: 'snapshot', at: new Date().toISOString(), dir, members: readBoard({ dir, all, asleep: sleepingHere(), only, upTo }) }),
        emit: (event) => { if (!only || only.includes(event.member)) write(event); },
      });
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
  // The hint, the blank line above it, and the cursor line below take 3.
  const redraw = () => {
    const height = process.stdout.isTTY ? process.stdout.rows || 0 : 0;
    // The hint only shows when the whole board fits beside it. Otherwise
    // members get every row, with no final newline that scrolls the header,
    // so a taller window never shows fewer members than a shorter one.
    const whole = draw();
    const short = height > 0 && whole.split('\n').length + 3 > height;
    const width = process.stdout.isTTY ? process.stdout.columns || 0 : 0;
    const hint = ['redraws every 3s, ctrl-c to stop', 'updates 3s, ctrl-c to stop', 'ctrl-c to stop', 'ctrl-c']
      .find((text) => !width || text.length <= width) || '';
    const board = short ? draw(height) : whole;
    process.stdout.write(`\x1b[2J\x1b[H${board}${short ? '' : `\n\n${hint}\n`}`);
  };
  redraw();
  // The member route exits once this settles, so only settle on ctrl-c. A
  // resized window redraws at once, so a frame drawn for the old width does
  // not sit wrapped on screen until the next redraw. A log that grows, shrinks,
  // is replaced, or goes away redraws within a beat too, so a stale row never
  // waits out the 3s timer. Bursts of writes share one redraw.
  return new Promise((resolve) => {
    let watcher = null;
    let soon = null;
    const changed = () => { if (!soon) soon = setTimeout(() => { soon = null; redraw(); }, 100); };
    const watchLogs = () => {
      if (watcher) return;
      try {
        watcher = fs.watch(progressDir(), changed);
        watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
      } catch { watcher = null; }
    };
    watchLogs();
    // The progress folder may not exist yet; keep trying on the timed redraw.
    const timer = setInterval(() => { watchLogs(); redraw(); }, 3000);
    process.stdout.on('resize', redraw);
    process.once('SIGINT', () => {
      clearInterval(timer);
      clearTimeout(soon);
      if (watcher) { try { watcher.close(); } catch {} }
      process.stdout.off('resize', redraw);
      resolve();
    });
  });
}

module.exports = {
  readBoard, renderBoard, memberRow, ago, progressEvent, followBoard, memberBoardCommand,
  parseStarted, teamHere, isAlive, stopMember, memberStopCommand,
};

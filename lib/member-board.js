'use strict';

// One screen of every member with a progress log: what job it is on, its last
// step, how long ago that was, and whether it is working, quiet, or done.
// Reads the logs lib/member-progress.js writes: "<iso> <mission> <text>".

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  return { at, text: m[3] };
}

function cut(text, width) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 3)}...` : s;
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Housekeeping: every path the step touches sits in the member's own log
// folder. Progress lines are cut at 100 chars, so a last path that is only the
// start of that folder still counts.
function onlyOwnLog(name, text) {
  const dir = `atris/team/${name}/logs`;
  const paths = text.split(/[\s;&|<>()'"`=]+/).filter((t) => t.includes('/'));
  if (!paths.length) return false;
  return paths.every((p, i) => {
    const rel = p.replace(/^.*?(?=atris\/team\/)/, '');
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
    return i === paths.length - 1 && dir.startsWith(rel) && rel.startsWith('atris/team/');
  });
}

// The current run is everything from the latest "started:" line on.
// Steps that only write the member's own log are housekeeping, so the last
// step column skips them unless nothing else happened.
function memberRow(name, text, now) {
  const lines = text.split('\n').map(parseLine).filter(Boolean);
  if (!lines.length) return null;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.startsWith('started:')) { start = i; break; }
  }
  const run = lines.slice(start);
  const startedLine = run[0].text.startsWith('started:') ? run[0] : null;
  const finished = [...run].reverse().find((l) => l.text.startsWith('finished:'));
  const steps = run.filter((l) => !l.text.startsWith('started:') && !l.text.startsWith('finished:'));
  const real = steps.filter((l) => !onlyOwnLog(name, l.text));
  const step = real[real.length - 1] || steps[steps.length - 1];
  const last = run[run.length - 1];
  let state;
  if (finished) state = /^finished:\s*ok\b/.test(finished.text) ? 'done ok' : 'done failed';
  else state = now - last.at < QUIET_AFTER_MS ? 'working' : 'quiet';
  return {
    member: name,
    state,
    job: startedLine ? cut(startedLine.text.slice('started:'.length), JOB_WIDTH) : '',
    step: step ? cut(step.text, STEP_WIDTH) : '',
    ago: ago(now - last.at),
    at: last.at,
    // Finished more than an hour ago: off the board unless --all.
    idle: last.text.startsWith('finished:') && now - last.at > HIDE_DONE_AFTER_MS,
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
  const w = (key, min) => Math.max(min, ...rows.map((r) => r[key].length));
  const nameW = w('member', 6);
  const stateW = w('state', 5);
  const agoW = w('ago', 3);
  const jobW = Math.max(3, ...rows.map((r) => (r.job || '-').length));
  const pad = (s, n) => s.padEnd(n);
  const line = (a, b, c, d, e) => `${pad(a, nameW)}  ${pad(b, stateW)}  ${pad(c, agoW)}  ${pad(d, jobW)}  ${e}`.trimEnd();
  const out = [line('member', 'state', 'ago', 'job', 'last step')];
  for (const r of rows) out.push(line(r.member, r.state, r.ago, r.job || '-', r.step || '-'));
  if (note) out.push('', note);
  return out.join('\n');
}

function memberBoardCommand(...args) {
  const asJson = args.includes('--json');
  const all = args.includes('--all');
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

module.exports = { readBoard, renderBoard, memberRow, ago, memberBoardCommand };

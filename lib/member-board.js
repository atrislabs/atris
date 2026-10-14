'use strict';

// One screen of every member with a progress log: what job it is on, its last
// step, how long ago that was, and whether it is working, quiet, or done.
// Reads the logs lib/member-progress.js writes: "<iso> <mission> <text>".

const fs = require('fs');
const os = require('os');
const path = require('path');

const QUIET_AFTER_MS = 2 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const JOB_WIDTH = 50;
const STEP_WIDTH = 50;

function progressDir() {
  return process.env.ATRIS_PROGRESS_DIR || path.join(os.homedir(), '.atris', 'progress');
}

// Read back from the end, doubling the window, until the latest "started:"
// line is in view (or the whole file is), so a long run keeps its job.
function readCurrentRun(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let want = Math.min(size, TAIL_BYTES);
    for (;;) {
      const start = size - want;
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, start);
      let text = buf.toString('utf8');
      // A cut read starts mid-line; drop the partial first line.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      if (start === 0 || /^\S+ \S+ started:/m.test(text)) return text;
      want = Math.min(size, want * 2);
    }
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
  const s = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.length > width ? `${s.slice(0, width - 3)}...` : s;
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The current run is everything from the latest "started:" line on.
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
  const step = [...run].reverse().find((l) => !l.text.startsWith('started:') && !l.text.startsWith('finished:'));
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
  };
}

function readBoard({ dir = progressDir(), now = Date.now() } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch {}
  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = readCurrentRun(path.join(dir, f)); } catch { continue; }
    const row = memberRow(f.slice(0, -'.log'.length).toLowerCase(), text, now);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => b.at - a.at);
}

function renderBoard(rows, dir = progressDir()) {
  if (!rows.length) return `no member progress yet in ${dir}`;
  const w = (key, min) => Math.max(min, ...rows.map((r) => r[key].length));
  const nameW = w('member', 6);
  const stateW = w('state', 5);
  const agoW = w('ago', 3);
  const jobW = Math.max(3, ...rows.map((r) => (r.job || '-').length));
  const pad = (s, n) => s.padEnd(n);
  const line = (a, b, c, d, e) => `${pad(a, nameW)}  ${pad(b, stateW)}  ${pad(c, agoW)}  ${pad(d, jobW)}  ${e}`.trimEnd();
  const out = [line('member', 'state', 'ago', 'job', 'last step')];
  for (const r of rows) out.push(line(r.member, r.state, r.ago, r.job || '-', r.step || '-'));
  return out.join('\n');
}

function memberBoardCommand(...args) {
  const asJson = args.includes('--json');
  if (asJson) {
    console.log(JSON.stringify({ ok: true, dir: progressDir(), members: readBoard() }, null, 2));
    return;
  }
  const draw = () => renderBoard(readBoard());
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

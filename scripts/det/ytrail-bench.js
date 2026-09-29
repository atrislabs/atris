#!/usr/bin/env node
'use strict';

// Bench what users get from `atris youtube notes`, end to end, uncached.
// Usage: node scripts/det/ytrail-bench.js [--quick] [--case <name>]
// Prints one line per case and a final "bench: X/Y passed in Ns"; exits 1 if
// any case fails. Rows (with a `case` field) go to $YTRAIL_OUT_DIR/ytrail.jsonl,
// default ~/.atris/benchmarks, outside any git repo.
// ytnotes is resolved next to this file, so an installed copy benches itself.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, appendRow } = require('./ytrail-eval');

const YTNOTES = path.join(__dirname, 'ytnotes');
const STRANGER_TIMEOUT_MS = 300000;

const CASES = [
  { name: 'captioned-short', kind: 'graded', url: 'https://www.youtube.com/watch?v=Z3JyAqh4ixg', quick: true },
  { name: 'captioned-long', kind: 'graded', url: 'https://www.youtube.com/watch?v=Am7IWP8IpEc' },
  { name: 'no-captions', kind: 'no-captions', url: 'https://www.youtube.com/watch?v=6DRlX5vIOE0', minWords: 50 },
  { name: 'stranger-no-downloader', kind: 'no-downloader', url: 'https://www.youtube.com/watch?v=Am7IWP8IpEc', quick: true },
  { name: 'stranger-no-writer', kind: 'no-writer', url: 'https://www.youtube.com/watch?v=Am7IWP8IpEc', quick: true },
];

function parseArgs(argv) {
  const opts = { quick: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--quick') opts.quick = true;
    else if (argv[i] === '--case') opts.only = argv[++i] || '';
    else if (argv[i].startsWith('--case=')) opts.only = argv[i].slice('--case='.length);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return opts;
}

function selectCases(opts, cases = CASES) {
  if (opts.only !== null) {
    const found = cases.filter((c) => c.name === opts.only);
    if (!found.length) {
      throw new Error(`unknown case: ${opts.only} (cases: ${cases.map((c) => c.name).join(', ')})`);
    }
    return found;
  }
  return opts.quick ? cases.filter((c) => c.quick) : cases.slice();
}

// First executable named `name` on PATH, then in the extra dirs.
function findBinary(name, env = process.env, extraDirs = []) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean).concat(extraDirs);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function findWhisper(env = process.env) {
  return findBinary('mlx_whisper', env, [path.join(os.homedir(), '.local', 'bin')]);
}

function findYtDlp(env = process.env) {
  return findBinary('yt-dlp', env, [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin']);
}

// Pure pass/fail rules. Each takes a finished run and returns { pass, note }.
function judgeNoCaptions({ whisper, row, stderr }) {
  if (whisper) {
    return { pass: Boolean(row.pass), note: 'local transcription' };
  }
  const pass = row.exit === 2 && /atris youtube process/.test(stderr || '');
  return { pass, note: 'no speech model, paid command offered' };
}

function judgeNoDownloader({ status, stderr }) {
  const text = String(stderr || '');
  const pass = status === 2 && /missing yt-dlp/.test(text) && !/No English captions/.test(text);
  return { pass, note: pass ? 'says to install yt-dlp' : 'did not say to install yt-dlp' };
}

function judgeNoWriter({ status, stderr, notesLeft }) {
  const text = String(stderr || '');
  const pass = status === 3 && /No AI writer is installed/.test(text) && !notesLeft;
  return { pass, note: pass ? 'says to install an AI writer' : 'did not say to install an AI writer' };
}

// Run ytnotes as a stranger would: a bare HOME, and only node (plus yt-dlp
// when given) on top of the system dirs.
function runStranger(url, { ytDlp = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytrail-stranger-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  if (ytDlp) fs.symlinkSync(ytDlp, path.join(bin, 'yt-dlp'));
  try {
    const started = Date.now();
    const run = spawnSync(YTNOTES, [url], {
      encoding: 'utf8',
      cwd: tmp,
      env: { HOME: tmp, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp },
      timeout: STRANGER_TIMEOUT_MS,
    });
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    const id = String(url).match(/[?&]v=([^&]+)/)[1];
    const notesLeft = fs.existsSync(path.join(tmp, 'ytnotes', `yt_${id}.md`));
    return { status: run.status, stderr: String(run.stderr || ''), seconds, notesLeft };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function lastLines(text, n = 3) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n).map((line) => `  ${line}`).join('\n');
}

function runCase(c) {
  if (c.kind === 'graded' || c.kind === 'no-captions') {
    const whisper = c.kind === 'no-captions' ? findWhisper() : null;
    const { row, stderr } = evaluate({ url: c.url, engine: 'auto', minWords: c.minWords });
    let verdict = { pass: row.pass, note: null };
    if (c.kind === 'no-captions') verdict = judgeNoCaptions({ whisper, row, stderr });
    const q = row.quotes;
    const parts = [
      `${c.name} ${verdict.pass ? 'pass' : 'fail'} ${row.seconds}s`,
      verdict.note ? `(${verdict.note})` : null,
      `exit=${row.exit === null ? 'none' : row.exit}`,
      `words=${row.words}`,
      `writer=${row.writer || 'none'}`,
      q ? `quotes=${q.kept} kept/${q.repaired} repaired/${q.dropped} dropped` : null,
    ].filter(Boolean);
    return {
      pass: verdict.pass,
      line: parts.join(' '),
      detail: verdict.pass ? '' : lastLines(stderr),
      row: { ...row, case: c.name, pass: verdict.pass, ...(verdict.note ? { path: verdict.note } : {}) },
    };
  }

  let ytDlp = null;
  if (c.kind === 'no-writer') {
    ytDlp = findYtDlp();
    if (!ytDlp) {
      return {
        skipped: true,
        line: `${c.name} skipped: no yt-dlp on this computer to test with`,
        row: { ts: new Date().toISOString(), case: c.name, url: c.url, skipped: true },
      };
    }
  }
  const run = runStranger(c.url, { ytDlp });
  const verdict = c.kind === 'no-writer' ? judgeNoWriter(run) : judgeNoDownloader(run);
  return {
    pass: verdict.pass,
    line: `${c.name} ${verdict.pass ? 'pass' : 'fail'} ${run.seconds}s exit=${run.status === null ? 'none' : run.status} (${verdict.note})`,
    detail: verdict.pass ? '' : lastLines(run.stderr),
    row: {
      ts: new Date().toISOString(),
      case: c.name,
      url: c.url,
      seconds: run.seconds,
      pass: verdict.pass,
      exit: run.status,
      notesLeft: run.notesLeft,
    },
  };
}

function summary(results, seconds) {
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.pass).length;
  const skipped = results.length - ran.length;
  return `bench: ${passed}/${ran.length} passed in ${seconds}s${skipped ? ` (${skipped} skipped)` : ''}`;
}

function main() {
  let cases;
  try {
    cases = selectCases(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    console.error('usage: ytrail-bench [--quick] [--case <name>]');
    process.exit(2);
  }
  const outDir = process.env.YTRAIL_OUT_DIR || path.join(os.homedir(), '.atris', 'benchmarks');
  const started = Date.now();
  const results = [];
  for (const c of cases) {
    const result = runCase(c);
    results.push(result);
    console.log(result.line);
    if (result.detail) console.log(result.detail);
    appendRow(outDir, result.row);
  }
  console.log(summary(results, Math.round((Date.now() - started) / 1000)));
  process.exit(results.some((r) => !r.skipped && !r.pass) ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  CASES,
  parseArgs,
  selectCases,
  findBinary,
  judgeNoCaptions,
  judgeNoDownloader,
  judgeNoWriter,
  summary,
};

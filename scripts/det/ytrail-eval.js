#!/usr/bin/env node
'use strict';

// Score one ytnotes run. Usage:
//   node scripts/det/ytrail-eval.js [url] [engine]
// Default url: https://www.youtube.com/watch?v=Z3JyAqh4ixg
// Default engine: auto (what users get)
// Each run gets a fresh, empty TMPDIR, so nothing is cached and the timing
// is real. YTRAIL_OUT_DIR sets where ytrail.jsonl goes (default
// <root>/atris/benchmarks). YTRAIL_MIN_WORDS sets the transcript floor
// (default 1000).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=Z3JyAqh4ixg';
const DEFAULT_ENGINE = 'auto';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MIN_WORDS = 1000;
const ROOT = path.resolve(__dirname, '..', '..');
const YTNOTES = path.join(__dirname, 'ytnotes');

function videoId(url) {
  const watch = String(url).match(/[?&]v=([^&]+)/);
  if (watch) return watch[1];
  const short = String(url).match(/youtu\.be\/([^?&/]+)/);
  return short ? short[1] : null;
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[‘’“”'"]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreQuotes(notes, transcript) {
  const flat = norm(transcript);
  const spans = [...String(notes).matchAll(/[“"]([^“”"]{15,240})[”"]/g)]
    .map((m) => m[1])
    .slice(0, 8);
  let ok = 0;
  for (const q of spans) {
    const words = norm(q).split(' ').filter(Boolean);
    const probe = words.slice(0, Math.min(6, words.length)).join(' ');
    if (probe && flat.includes(probe)) ok += 1;
  }
  const needed = spans.length / 2;
  return {
    spans: spans.length,
    verified: ok,
    pass: spans.length >= 2 && ok >= needed,
  };
}

function firstLine(text) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
}

// ytquote-repair prints "quotes: N kept, N repaired, N dropped" to stderr.
function parseQuoteRepair(stderr) {
  const match = String(stderr || '').match(/quotes: (\d+) kept, (\d+) repaired, (\d+) dropped/);
  if (!match) return null;
  return { kept: Number(match[1]), repaired: Number(match[2]), dropped: Number(match[3]) };
}

// ytnotes prints "notes by <writer>" to stderr once notes are written.
function parseWriter(stderr) {
  const matches = [...String(stderr || '').matchAll(/^notes by (.+)$/gm)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

function parseMinWords(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_WORDS;
}

function outDir(env = process.env) {
  return env.YTRAIL_OUT_DIR || path.join(ROOT, 'atris', 'benchmarks');
}

// Pure grade of one finished run.
function gradeRun({ status, notes, transcript, minWords = DEFAULT_MIN_WORDS }) {
  const quotes = scoreQuotes(notes, transcript);
  const words = wordCount(transcript);
  const checks = {
    exit0: status === 0,
    transcriptWords: words >= minWords,
    notesExist: String(notes).trim().length > 0,
    notesHeading: firstLine(notes).startsWith('#'),
    quoteHonesty: quotes.pass,
  };
  return { pass: Object.values(checks).every(Boolean), checks, words, quoteScore: quotes };
}

function readIfExists(file) {
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Run ytnotes once in a fresh TMPDIR, grade it, and clean up. Writes nothing.
function evaluate(options = {}) {
  const url = options.url || DEFAULT_URL;
  const engine = options.engine || DEFAULT_ENGINE;
  const minWords = options.minWords === undefined ? DEFAULT_MIN_WORDS : options.minWords;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytrail-'));
  const workDir = path.join(tmp, 'ytnotes');
  const id = videoId(url);

  try {
    const started = Date.now();
    const run = spawnSync(options.ytnotes || YTNOTES, [url, engine], {
      encoding: 'utf8',
      cwd: options.cwd || ROOT,
      env: { ...(options.env || process.env), TMPDIR: tmp },
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    const stderr = String(run.stderr || '');
    const notes = readIfExists(id && path.join(workDir, `yt_${id}.md`)) || String(run.stdout || '');
    const transcript = readIfExists(id && path.join(workDir, `yt_${id}.clean.txt`));
    const grade = gradeRun({ status: run.status, notes, transcript, minWords });
    const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');

    const row = {
      ts: new Date().toISOString(),
      url,
      engine,
      seconds,
      pass: grade.pass,
      checks: grade.checks,
      exit: run.status,
      timedOut,
      writer: parseWriter(stderr),
      quotes: parseQuoteRepair(stderr),
      words: grade.words,
      minWords,
    };
    return { row, grade, stderr, status: run.status };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Keep the head of this line as is: ytrail-race.js parses it.
function formatLine(row, grade) {
  const head = `ytrail ${row.pass ? 'pass' : 'fail'} ${row.engine} ${row.seconds}s words=${grade.words} quotes=${grade.quoteScore.verified}/${grade.quoteScore.spans} heading=${grade.checks.notesHeading ? 'yes' : 'no'}`;
  return `${head} writer=${row.writer || 'none'} exit=${row.exit === null ? 'none' : row.exit}`;
}

function appendRow(dir, row) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'ytrail.jsonl'), `${JSON.stringify(row)}\n`);
}

function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const engine = process.argv[3] || DEFAULT_ENGINE;
  const minWords = parseMinWords(process.env.YTRAIL_MIN_WORDS);
  const { row, grade, stderr, status } = evaluate({ url, engine, minWords });

  appendRow(outDir(), row);
  console.log(formatLine(row, grade));
  if (status !== 0 && stderr) {
    console.log(stderr.trim().split('\n').slice(-8).join('\n'));
  }

  process.exit(row.pass ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_URL,
  DEFAULT_ENGINE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MIN_WORDS,
  videoId,
  wordCount,
  scoreQuotes,
  parseQuoteRepair,
  parseWriter,
  parseMinWords,
  outDir,
  gradeRun,
  evaluate,
  formatLine,
  appendRow,
};

#!/usr/bin/env node
'use strict';

// Score one ytnotes run. Usage:
//   node scripts/det/ytrail-eval.js [url] [engine]
// Default url: https://www.youtube.com/watch?v=Z3JyAqh4ixg
// Default engine: haiku

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=Z3JyAqh4ixg';
const DEFAULT_ENGINE = 'haiku';

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
    pass: ok >= needed,
  };
}

function firstLine(text) {
  return String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
}

function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const engine = process.argv[3] || DEFAULT_ENGINE;
  const root = path.resolve(__dirname, '..', '..');
  const ytnotes = path.join(root, 'scripts', 'det', 'ytnotes');
  const workDir = path.join(process.env.TMPDIR || '/tmp', 'ytnotes');
  const id = videoId(url);
  const transcriptPath = id ? path.join(workDir, `yt_${id}.clean.txt`) : '';
  const notesPath = id ? path.join(workDir, `yt_${id}.md`) : '';

  const started = Date.now();
  const run = spawnSync(ytnotes, [url, engine], {
    encoding: 'utf8',
    cwd: root,
    env: process.env,
    timeout: 180000,
  });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

  const stdoutNotes = String(run.stdout || '');
  let fileNotes = '';
  if (notesPath && fs.existsSync(notesPath)) {
    fileNotes = fs.readFileSync(notesPath, 'utf8');
  }
  const notes = fileNotes || stdoutNotes;

  let transcript = '';
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    transcript = fs.readFileSync(transcriptPath, 'utf8');
  }

  const quotes = scoreQuotes(notes, transcript);
  const checks = {
    exit0: run.status === 0,
    transcriptWords: wordCount(transcript) >= 1000,
    notesExist: notes.trim().length > 0,
    notesHeading: firstLine(notes).startsWith('#'),
    quoteHonesty: quotes.pass,
  };
  const pass = Object.values(checks).every(Boolean);

  const row = {
    ts: new Date().toISOString(),
    url,
    engine,
    seconds,
    pass,
    checks,
  };

  const outDir = path.join(root, 'atris', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, 'ytrail.jsonl'), `${JSON.stringify(row)}\n`);

  const words = wordCount(transcript);
  console.log(
    `ytrail ${pass ? 'pass' : 'fail'} ${engine} ${seconds}s words=${words} quotes=${quotes.verified}/${quotes.spans} heading=${checks.notesHeading ? 'yes' : 'no'}`
  );
  if (run.status !== 0 && run.stderr) {
    console.log(String(run.stderr).trim().split('\n').slice(-8).join('\n'));
  }

  process.exit(pass ? 0 : 1);
}

main();

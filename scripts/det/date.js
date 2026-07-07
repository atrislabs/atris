#!/usr/bin/env node
// det/date.js — deterministic date/time conversion. Epoch<->ISO and weekday are
// the asks LLMs fumble most (seconds vs ms, and timezone guesses). Everything is
// UTC so the answer is the same on every machine. Reads stdin, writes stdout.
//
// Usage:
//   echo 1700000000    | node date.js iso       # epoch (s or ms) -> ISO 8601 UTC
//   echo 2026-07-07    | node date.js epoch      # date/ISO -> epoch seconds
//   echo 2026-07-07    | node date.js epochms    # -> epoch milliseconds
//   echo 2026-07-07    | node date.js weekday    # -> Monday..Sunday (UTC)
//
// Modes: iso | epoch | epochms | weekday
// Bare date strings (no timezone) are read as UTC. Exit 2 on bad mode/input.

'use strict';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Parse stdin into a Date, deterministically. A pure-digit string is an epoch
// (>=13 digits = ms, else seconds). Otherwise a date string; if it carries no
// timezone we pin it to UTC by appending 'Z' so machines don't disagree.
function toDate(s) {
  const t = s.trim();
  if (t === '') return { error: 'empty input' };
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    const ms = t.replace('-', '').length >= 13 ? n : n * 1000;
    return { date: new Date(ms) };
  }
  // ISO-ish without an explicit zone/offset -> treat as UTC.
  let str = t;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(t);
  if (!hasZone) {
    str = /\d{4}-\d{2}-\d{2}$/.test(t) ? t + 'T00:00:00Z' : t + 'Z';
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return { error: `cannot parse date: ${t}` };
  return { date: d };
}

// Pure core: returns { text } or { error }.
function run(mode, input) {
  const p = toDate(input);
  if (p.error) return { error: p.error };
  const d = p.date;
  switch (mode) {
    case 'iso':
      return { text: d.toISOString() };
    case 'epoch':
      return { text: String(Math.floor(d.getTime() / 1000)) };
    case 'epochms':
      return { text: String(d.getTime()) };
    case 'weekday':
      return { text: DAYS[d.getUTCDay()] };
    default:
      return { error: `unknown mode: ${mode}` };
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

const MODES = ['iso', 'epoch', 'epochms', 'weekday'];

async function main() {
  const mode = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!mode || !MODES.includes(mode)) {
    process.stderr.write(`unknown mode: ${mode || '(none)'}\nmodes: ${MODES.join(' | ')}\n`);
    process.exit(2);
  }
  const input = await readStdin();
  const res = run(mode, input);
  if (res.error) {
    process.stderr.write(res.error + '\n');
    process.exit(2);
  }
  if (res.text.length) process.stdout.write(res.text + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { run, toDate, MODES };

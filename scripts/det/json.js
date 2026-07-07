#!/usr/bin/env node
// det/json.js — deterministic JSON reshaping. The reformat/validate/flatten asks
// an LLM does by hand (and mis-escapes). Reads JSON on stdin, writes stdout.
//
// Usage:
//   cat data.json | node json.js pretty          # 2-space indent
//   node json.js min      < data.json             # minified, one line
//   node json.js validate < data.json             # prints "valid" or errors (exit 2)
//   node json.js keys     < data.json             # top-level keys, one per line
//   node json.js csv      < array.json            # array of objects -> RFC-4180 CSV
//
// Modes: pretty | min | validate | keys | csv
// Exit 0 on success, 2 on invalid JSON or bad mode/shape.

'use strict';

function parse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// RFC-4180: quote a field if it holds comma, quote, CR or LF; double inner quotes.
function csvField(v) {
  let s;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(arr) {
  if (!Array.isArray(arr)) throw new Error('csv mode needs a JSON array of objects');
  if (arr.length === 0) return '';
  // Column order = first-seen key order across all rows (stable, deterministic).
  const cols = [];
  const seen = new Set();
  for (const row of arr) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('csv mode needs each item to be an object');
    }
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const lines = [cols.map(csvField).join(',')];
  for (const row of arr) {
    lines.push(cols.map((c) => csvField(row[c])).join(','));
  }
  return lines.join('\n');
}

// Returns { text } on success or { error } on failure. Pure — unit-testable.
function run(mode, input) {
  if (mode === 'validate') {
    const p = parse(input);
    return p.ok ? { text: 'valid' } : { error: p.error };
  }
  const p = parse(input);
  if (!p.ok) return { error: p.error };
  const v = p.value;
  switch (mode) {
    case 'pretty':
      return { text: JSON.stringify(v, null, 2) };
    case 'min':
      return { text: JSON.stringify(v) };
    case 'keys':
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { error: 'keys mode needs a JSON object' };
      }
      return { text: Object.keys(v).join('\n') };
    case 'csv':
      try {
        return { text: toCsv(v) };
      } catch (e) {
        return { error: e.message };
      }
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

const MODES = ['pretty', 'min', 'validate', 'keys', 'csv'];

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

module.exports = { run, toCsv, MODES };

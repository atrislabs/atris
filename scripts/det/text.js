#!/usr/bin/env node
// det/text.js — deterministic line-and-word chores an LLM gets asked to eyeball
// (and miscounts). Reads text on stdin, writes stdout.
//
// Usage:
//   cat list.txt | node text.js dedupe        # drop duplicate lines, keep first order
//   node text.js sort   < list.txt            # sort lines (byte order)
//   node text.js rsort  < list.txt            # reverse sort
//   node text.js count  < list.txt            # lines / words / chars, one metric per line
//   node text.js slug   < title.txt           # each line -> url slug
//   node text.js trim   < messy.txt           # strip trailing ws, drop blank lines
//
// Modes: dedupe | sort | rsort | count | slug | trim
// Exit 0 on success, 2 on bad mode.

'use strict';

function splitLines(input) {
  // Normalize CRLF, drop a single trailing newline so "a\nb\n" is 2 lines not 3.
  const t = input.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return t === '' ? [] : t.split('\n');
}

function slugify(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric -> hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

// Pure core: returns { text } or { error }. Unit-testable without process I/O.
function run(mode, input) {
  const lines = splitLines(input);
  switch (mode) {
    case 'dedupe': {
      const seen = new Set();
      const out = [];
      for (const l of lines) {
        if (!seen.has(l)) {
          seen.add(l);
          out.push(l);
        }
      }
      return { text: out.join('\n') };
    }
    case 'sort':
      return { text: [...lines].sort().join('\n') };
    case 'rsort':
      return { text: [...lines].sort().reverse().join('\n') };
    case 'count': {
      const words = (input.match(/\S+/g) || []).length;
      const chars = input.replace(/\n$/, '').length;
      return { text: `lines\t${lines.length}\nwords\t${words}\nchars\t${chars}` };
    }
    case 'slug':
      return { text: lines.map(slugify).join('\n') };
    case 'trim':
      return {
        text: lines
          .map((l) => l.replace(/\s+$/, ''))
          .filter((l) => l.trim() !== '')
          .join('\n'),
      };
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

const MODES = ['dedupe', 'sort', 'rsort', 'count', 'slug', 'trim'];

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

module.exports = { run, slugify, MODES };

#!/usr/bin/env node
// det/extract.js — deterministically pull structured items out of text.
// Replaces the "extract all the X from this" ask that a cheap LLM does slowly
// and sometimes wrong. Reads stdin, writes one item per line to stdout.
//
// Usage:
//   cat file.txt | node extract.js urls
//   node extract.js emails < file.txt
//   node extract.js code < README.md        # fenced ```code blocks
//   node extract.js numbers < report.txt
//   node extract.js --json urls < file.txt   # JSON array instead of lines
//
// Kinds: urls | emails | code | numbers | ipv4 | hashtags
// Exit 0 with output, exit 2 on bad/unknown kind. Duplicates removed, order preserved.

'use strict';

const EXTRACTORS = {
  urls: (t) => match(t, /\bhttps?:\/\/[^\s<>"')\]]+/g).map(stripTrailingPunct),
  emails: (t) => match(t, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),
  ipv4: (t) => match(t, /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g),
  hashtags: (t) => match(t, /(?:^|\s)(#[A-Za-z0-9_]+)/g).map((m) => m.trim()),
  numbers: (t) => match(t, /-?\b\d[\d,]*(?:\.\d+)?\b/g),
  code: (t) => {
    // Fenced blocks: ```lang\n...\n```  — return block contents (not fences).
    const blocks = [];
    const re = /```[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(t)) !== null) blocks.push(m[1].replace(/\n$/, ''));
    return blocks;
  },
};

function match(text, re) {
  return text.match(re) || [];
}

function stripTrailingPunct(s) {
  return s.replace(/[.,;:!?]+$/, '');
}

function dedupePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!seen.has(it)) {
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

function extract(kind, text) {
  const fn = EXTRACTORS[kind];
  if (!fn) return null;
  return dedupePreserveOrder(fn(text));
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

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const kind = args.find((a) => !a.startsWith('-'));
  if (!kind || !EXTRACTORS[kind]) {
    process.stderr.write(
      `unknown kind: ${kind || '(none)'}\nkinds: ${Object.keys(EXTRACTORS).join(' | ')}\n`
    );
    process.exit(2);
  }
  const text = await readStdin();
  const items = extract(kind, text);
  if (json) {
    process.stdout.write(JSON.stringify(items) + '\n');
  } else if (items.length) {
    process.stdout.write(items.join('\n') + '\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { extract, EXTRACTORS };

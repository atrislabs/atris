#!/usr/bin/env node
// det/hunk-filter.js - keep only unified-diff hunks whose lines match a regex.
// For concurrent-editor workspaces: stage YOUR hunk of a shared file without
// sweeping in other agents' churn (git apply --cached the filtered patch).
//
// Usage:
//   git diff -U1 -- path/file | node scripts/det/hunk-filter.js "<regex>"
//   git diff -U1 -- path/file | node scripts/det/hunk-filter.js "Horizon" | git apply --cached --unidiff-zero -
//
// A file section is printed only when at least one of its hunks matches.
// Exit 0 on success (even if nothing matched), 2 on missing pattern.
'use strict';

function filterHunks(diffText, pattern) {
  const re = new RegExp(pattern);
  const lines = String(diffText).split('\n');
  const out = [];
  let header = [];
  let hunk = null;
  let fileHasMatch = false;
  let fileHunks = [];

  const flushFile = () => {
    if (fileHasMatch && fileHunks.length) {
      out.push(...header, ...fileHunks);
    }
    header = [];
    fileHunks = [];
    fileHasMatch = false;
  };
  const flushHunk = () => {
    if (!hunk) return;
    if (hunk.some((l) => re.test(l))) {
      fileHunks.push(...hunk);
      fileHasMatch = true;
    }
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      flushFile();
      header = [line];
    } else if (line.startsWith('@@')) {
      flushHunk();
      hunk = [line];
    } else if (hunk) {
      hunk.push(line);
    } else {
      header.push(line);
    }
  }
  flushHunk();
  flushFile();
  const text = out.join('\n');
  return text && !text.endsWith('\n') ? `${text}\n` : text;
}

module.exports = { filterHunks };

if (require.main === module) {
  const pattern = process.argv[2];
  if (!pattern) {
    console.error('usage: git diff -U1 -- file | hunk-filter.js "<regex>"');
    process.exit(2);
  }
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    process.stdout.write(filterHunks(input, pattern));
  });
}

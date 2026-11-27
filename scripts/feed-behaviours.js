#!/usr/bin/env node
'use strict';

// Run the feed's behaviour list (test/feed-behaviours.md): every row names
// the test that proves it. The feed test files run once, and each row prints
// pass or fail. Exits 1 when a release row fails or names a test that does
// not exist.
//
//   node scripts/feed-behaviours.js [--all] [--json]
//   --all   print every row, not only the ones that block a release

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIST = path.join(ROOT, 'test', 'feed-behaviours.md');
const FILES = ['decision-feed', 'feed-team', 'feed-recovery', 'feed-soak', 'feed-visual-kinds', 'feed-stream', 'feed-grounding', 'feed-scroll', 'feed-keep', 'feed-host', 'feed-sign-in', 'feed-turns'].map((name) => path.join('test', `${name}.test.js`));

function readRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4 || !/^\d+$/.test(cells[0])) continue;
    rows.push({ n: Number(cells[0]), behaviour: cells[1], test: cells[2], blocks: /^yes$/i.test(cells[3]) });
  }
  return rows;
}

function runTests() {
  const env = { ...process.env };
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_DISPATCH_DEPTH', 'ATRIS_AGENT_PROOF_ONLY']) delete env[marker];
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...FILES], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const results = new Map();
  for (const line of String(run.stdout || '').split('\n')) {
    const match = /^\s*(not ok|ok) \d+ - (.*?)(?:\s+#.*)?$/.exec(line);
    if (match) results.set(match[2].replace(/\\'/g, "'").replace(/\\#/g, '#'), match[1] === 'ok');
  }
  return results;
}

function main(args) {
  const rows = readRows(fs.readFileSync(LIST, 'utf8'));
  const results = runTests();
  const shown = args.includes('--all') ? rows : rows.filter((row) => row.blocks);
  const report = shown.map((row) => {
    const passed = results.has(row.test) ? results.get(row.test) : null;
    return { ...row, status: passed === null ? 'missing' : passed ? 'pass' : 'fail' };
  });
  const releaseRows = report.filter((row) => row.blocks);
  const ok = releaseRows.every((row) => row.status === 'pass');
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok, rows: rows.length, release_rows: releaseRows.length, passed: releaseRows.filter((r) => r.status === 'pass').length, report }, null, 2));
  } else {
    for (const row of report) console.log(`${row.status.padEnd(7)} ${String(row.n).padStart(2)}  ${row.behaviour}`);
    const passed = releaseRows.filter((row) => row.status === 'pass').length;
    console.log(`\n${passed} of ${releaseRows.length} release rows pass (${rows.length} rows in all).`);
  }
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));

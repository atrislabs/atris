'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { analyticsAtris } = require('../commands/analytics');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-analytics-cmd-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

// Mirror analytics.js's own date math (local tz, today minus N days) so the
// fixtures land on the exact log paths the command reads.
function writeLog(dir, daysAgo, body) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const p = path.join(dir, 'atris', 'logs', String(y), `${y}-${m}-${day}.md`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
}

function runAnalytics(dir) {
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(dir);
    analyticsAtris();
  } finally {
    console.log = prevLog;
    process.chdir(prevCwd);
  }
  return lines.join('\n');
}

test('analytics exits 1 and explains when atris/ folder is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-analytics-missing-'));
  const prevCwd = process.cwd();
  const prevLog = console.log;
  const prevExit = process.exit;
  const lines = [];
  const sentinel = new Error('exit');
  let exitCode = null;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    process.chdir(dir);
    process.exit = (code) => { exitCode = code; throw sentinel; };
    assert.throws(() => analyticsAtris(), (err) => err === sentinel);
    assert.equal(exitCode, 1);
    assert.match(lines.join('\n'), /atris\/ folder not found/);
  } finally {
    console.log = prevLog;
    process.exit = prevExit;
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics reports today completions and inbox counts from the journal', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, [
      '## Inbox',
      '- **I1: alpha**',
      '- **I2: beta**',
      '',
      '## Completed',
      '- **C1: first**',
      '- **C2: second**',
      '- **C3: third**',
      '',
    ].join('\n'));
    const out = runAnalytics(dir);
    assert.match(out, /Completions: 3/);
    assert.match(out, /Inbox items: 2/);
    assert.match(out, /Total completions: 3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics averages weekly velocity across journals on different days', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, ['## Done', '- **C1: a**', '- **C2: b**', ''].join('\n'));
    writeLog(dir, 5, ['## Done', '- **C1: c**', '- **C2: d**', '- **C3: e**', '- **C4: f**', '- **C5: g**', ''].join('\n'));
    const out = runAnalytics(dir);
    assert.match(out, /Total completions: 7/);
    assert.match(out, /Average velocity: 1\.0 completions\/day/);
    assert.match(out, /Completions: 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics marks the inbox trend shrinking when today has fewer items than 6 days ago', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 6, ['## Inbox', '- **I1: a**', '- **I2: b**', '- **I3: c**', ''].join('\n'));
    writeLog(dir, 0, ['## Inbox', '- **I1: a**', '', '## Notes', ''].join('\n'));
    const out = runAnalytics(dir);
    assert.match(out, /Inbox items: 1/);
    assert.match(out, /Inbox trend: Shrinking/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

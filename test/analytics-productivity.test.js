'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

// Mirror analytics.js's own date math (local tz, today minus N days) so the
// fixtures land on the exact log paths the command reads.
function logPathForDaysAgo(dir, daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rel = path.join('atris', 'logs', String(y), `${y}-${m}-${day}.md`);
  return path.join(dir, rel);
}

function writeLog(dir, daysAgo, body) {
  const p = logPathForDaysAgo(dir, daysAgo);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-analytics-prod-test-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

test('analytics picks the hour with the most timestamps as most active', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, [
      '## Notes',
      '',
      '### Brainstorm Session — 09:15',
      'a',
      '### Autopilot Iteration 1 — 09:42',
      'b',
      '### Autopilot Iteration 2 — 14:30',
      'c',
      '',
    ].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.match(out.stdout, /Most active hour: 9:00 - 10:00/);
    assert.match(out.stdout, /Activity count: 2 timestamps/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics counts the legacy **HH:MM:SS** timestamp form', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, [
      '## Notes',
      '',
      '**11:01:02** did a thing',
      '**11:59:00** did another',
      '',
    ].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.match(out.stdout, /Most active hour: 11:00 - 12:00/);
    assert.match(out.stdout, /Activity count: 2 timestamps/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics wraps the most-active hour label past midnight (23 -> 0)', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, ['## Notes', '', '### Late tick — 23:50', 'x', ''].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.match(out.stdout, /Most active hour: 23:00 - 0:00/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics reports "No data" for productive hours when there are no timestamps', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 0, ['## Completed ✅', '- **C1: shipped**', ''].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.match(out.stdout, /Most active hour: No data/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics inbox trend grows when today has more inbox items than 6 days ago', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 6, ['## Inbox', '- **I1: old idea**', ''].join('\n'));
    writeLog(dir, 0, [
      '## Inbox',
      '- **I1: a**',
      '- **I2: b**',
      '- **I3: c**',
      '',
      '## Notes',
      '',
    ].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.match(out.stdout, /Inbox items: 3/);
    assert.match(out.stdout, /Inbox trend: Growing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analytics inbox trend is stable when today and 6 days ago match', () => {
  const dir = makeWorkspace();
  try {
    writeLog(dir, 6, ['## Inbox', '- **I1: x**', ''].join('\n'));
    writeLog(dir, 0, ['## Inbox', '- **I1: x**', '', '## Notes', ''].join('\n'));
    const out = runCli(['analytics'], dir);
    assert.match(out.stdout, /Inbox trend: Stable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

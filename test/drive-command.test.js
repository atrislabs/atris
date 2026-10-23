'use strict';

// Command-level tests for commands/drive.js — the argument/help handling and
// the `status` subcommand, which reads .atris/state/drive.jsonl under cwd.
// The default tick path is not exercised: it spawns `atris mission doctor`
// against a real workspace with a 120s timeout, which is out of scope for a
// fast unit test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { driveCommand } = require('../commands/drive');

function makeWorkspace(prefix = 'atris-drive-cmd-') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function seedHistory(dir, records) {
  const file = path.join(dir, '.atris', 'state', 'drive.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

async function inWorkspace(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

async function captureLogs(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('drive --help prints usage and returns 0', async () => {
  const { result, lines } = await captureLogs(() => driveCommand(['--help']));
  assert.equal(result, 0);
  const out = lines.join('\n');
  assert.match(out, /atris drive/);
  assert.match(out, /--dry-run/);
  assert.match(out, /--json/);
  assert.match(out, /atris drive status/);
});

test('drive status --help takes the help branch before the status branch', async () => {
  const { result, lines } = await captureLogs(() => driveCommand(['status', '--help']));
  assert.equal(result, 0);
  const out = lines.join('\n');
  assert.match(out, /atris drive - one self-driving tick/);
  assert.doesNotMatch(out, /disengagements per tick/);
});

test('drive status with no history reports zero ticks and returns 0', async () => {
  const dir = makeWorkspace();
  try {
    const { result, lines } = await inWorkspace(dir, () =>
      captureLogs(() => driveCommand(['status'])));
    assert.equal(result, 0);
    assert.deepEqual(lines, ['No drive ticks yet. Run: atris drive']);
  } finally {
    cleanup(dir);
  }
});

test('drive status --json returns seeded history', async () => {
  const dir = makeWorkspace();
  try {
    const records = [
      { at: '2026-10-20T10:00:00.000Z', findings: 3, checked: 5, fixed: 2, disengagements: 1 },
      { at: '2026-10-21T10:00:00.000Z', findings: 1, checked: 6, fixed: 1, disengagements: 0 },
    ];
    seedHistory(dir, records);
    const { result, lines } = await inWorkspace(dir, () =>
      captureLogs(() => driveCommand(['status', '--json'])));
    assert.equal(result, 0);
    const payload = JSON.parse(lines.join('\n'));
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.ticks, records);
  } finally {
    cleanup(dir);
  }
});

test('drive status prints each tick with fixed and disengagement counts', async () => {
  const dir = makeWorkspace();
  try {
    seedHistory(dir, [
      { at: '2026-10-20T10:00:00.000Z', findings: 3, checked: 5, fixed: 2, disengagements: 1 },
      { at: '2026-10-21T10:00:00.000Z', findings: 1, checked: 6, fixed: 1, disengagements: 0 },
    ]);
    const { result, lines } = await inWorkspace(dir, () =>
      captureLogs(() => driveCommand(['status'])));
    assert.equal(result, 0);
    assert.match(lines[0], /disengagements per tick/);
    assert.ok(lines.some((l) => l.includes('2026-10-20T10:00:00.000Z') && l.includes('fixed 2/3') && l.includes('disengagements 1')));
    assert.ok(lines.some((l) => l.includes('2026-10-21T10:00:00.000Z') && l.includes('fixed 1/1') && l.includes('disengagements 0')));
  } finally {
    cleanup(dir);
  }
});

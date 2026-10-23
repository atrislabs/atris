'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { idleWithOnlyNotes, DEFAULT_TEAM_STATE } = require('../lib/zen');

// Fixed dates only, so the result never depends on the clock or today's date.
const OLD = new Date('2020-01-01T00:00:00Z');
const CUTOFF = Date.parse('2020-06-01T00:00:00Z');
const FRESH = new Date('2020-07-01T00:00:00Z');

// Everything the code could read from the machine goes under one temp root.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-idle-notes-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home);

const savedEnv = { HOME: process.env.HOME };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}
process.env.HOME = home;

test.after(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// A fresh repo with no commits. Each file gets the given mtime, and the head
// file gets headTime, which is what headMovedSince compares against the cutoff.
function makeCheckout(files, { headTime = OLD } = {}) {
  const dir = fs.mkdtempSync(path.join(sandbox, 'checkout-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [rel, time] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x\n');
    fs.utimesSync(file, time, time);
  }
  fs.utimesSync(path.join(dir, '.git', 'HEAD'), headTime, headTime);
  return dir;
}

test('idle copy holding only team notes counts as notes only', () => {
  const dir = makeCheckout({
    'atris/now.md': OLD,
    'atris/logs/2020/2020-01-01.md': OLD,
    'CLAUDE.md': OLD,
  });
  assert.equal(idleWithOnlyNotes(dir, DEFAULT_TEAM_STATE, CUTOFF), true);
});

test('any stray code, live data, or live log turns the answer to false', () => {
  const stray = makeCheckout({ 'atris/now.md': OLD, 'src/app.js': OLD });
  assert.equal(idleWithOnlyNotes(stray, DEFAULT_TEAM_STATE, CUTOFF), false);

  const database = makeCheckout({ 'atris/now.md': OLD, 'atris/state.db': OLD });
  assert.equal(idleWithOnlyNotes(database, DEFAULT_TEAM_STATE, CUTOFF), false);

  const ledger = makeCheckout({ 'atris/now.md': OLD, 'atris/runs.jsonl': OLD });
  assert.equal(idleWithOnlyNotes(ledger, DEFAULT_TEAM_STATE, CUTOFF), false);

  const clean = makeCheckout({});
  assert.equal(idleWithOnlyNotes(clean, DEFAULT_TEAM_STATE, CUTOFF), false);
});

test('a note edited after the cutoff, or a head moved after it, is not idle', () => {
  const freshNote = makeCheckout({ 'atris/now.md': FRESH });
  assert.equal(idleWithOnlyNotes(freshNote, DEFAULT_TEAM_STATE, CUTOFF), false);

  const movedHead = makeCheckout({ 'atris/now.md': OLD }, { headTime: FRESH });
  assert.equal(idleWithOnlyNotes(movedHead, DEFAULT_TEAM_STATE, CUTOFF), false);

  // Exactly at the cutoff still counts as idle, since the comparison is <=.
  const atCutoff = makeCheckout({ 'atris/now.md': new Date(CUTOFF) });
  assert.equal(idleWithOnlyNotes(atCutoff, DEFAULT_TEAM_STATE, CUTOFF), true);
});

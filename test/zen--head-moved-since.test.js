'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { headMovedSince } = require('../lib/zen');

const entrySeconds = 1700000000;
const entryTime = entrySeconds * 1000;

function fixture(t, initialize = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-head-moved-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_') || key.startsWith('GIT_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'no-git-config');
  if (initialize) {
    const result = spawnSync('git', ['init', '--quiet', '--template=', '--initial-branch=main', root], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
  }
  return root;
}

function setTime(file, milliseconds) {
  const date = new Date(milliseconds);
  fs.utimesSync(file, date, date);
}

test('uses the last history entry and a strictly later cutoff comparison', (t) => {
  const root = fixture(t);
  const log = path.join(root, '.git', 'logs', 'HEAD');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const hash = 'a'.repeat(40);
  fs.writeFileSync(log,
    `${hash} ${hash} Test <test@example.invalid> ${entrySeconds + 100} +0000\tcommit: first\n`
    + `${hash} ${hash} Test <test@example.invalid> ${entrySeconds} -0700\tcheckout: main\n`);
  // Upkeep can rewrite the file much later without moving HEAD.
  setTime(log, entryTime + 1000000);
  setTime(path.join(root, '.git', 'HEAD'), entryTime + 1000000);

  assert.strictEqual(headMovedSince(root, entryTime - 1), true);
  assert.strictEqual(headMovedSince(root, entryTime), false);
  assert.strictEqual(headMovedSince(root, entryTime + 1), false);
});

test('falls back to HEAD time when no history exists', (t) => {
  const root = fixture(t);
  setTime(path.join(root, '.git', 'HEAD'), entryTime);

  assert.strictEqual(headMovedSince(root, entryTime - 1), true);
  assert.strictEqual(headMovedSince(root, entryTime), false);
});

test('empty or malformed history falls back to the newest file time', (t) => {
  const root = fixture(t);
  const log = path.join(root, '.git', 'logs', 'HEAD');
  const head = path.join(root, '.git', 'HEAD');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  for (const content of ['', 'not a history entry\n']) {
    fs.writeFileSync(log, content);
    setTime(head, entryTime);
    setTime(log, entryTime + 2000);
    assert.strictEqual(headMovedSince(root, entryTime + 1000), true);
    assert.strictEqual(headMovedSince(root, entryTime + 2000), false);
    setTime(head, entryTime + 4000);
    assert.strictEqual(headMovedSince(root, entryTime + 3000), true);
  }
});

test('returns false for a folder outside a repository or a missing folder', (t) => {
  const root = fixture(t, false);
  assert.strictEqual(headMovedSince(root, entryTime), false);
  assert.strictEqual(headMovedSince(path.join(root, 'missing'), entryTime), false);
});

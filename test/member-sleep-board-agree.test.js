'use strict';

// `atris sleep <member>` and `atris member board` must agree on who is awake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readBoard, renderBoard } = require('../lib/member-board');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-board-'));
  for (const name of ['builder', 'validator', 'scout']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `# ${name}\n`);
  }
  const dir = path.join(root, 'progress');
  fs.mkdirSync(dir);
  const at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'builder.log'), `${at} m-1 started: fix the board\n${at} m-1 finished: ok\n`);
  fs.writeFileSync(path.join(dir, 'validator.log'), `${at} m-2 started: check the fix\n${at} m-2 finished: ok\n`);
  return { root, dir };
}

function atris(ws, ...args) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: ws.root, env: { ...process.env, ATRIS_PROGRESS_DIR: ws.dir }, encoding: 'utf8',
  });
  assert.equal(res.status, 0, `atris ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function board(ws) {
  const members = JSON.parse(atris(ws, 'member', 'board', '--json')).members;
  return Object.fromEntries(members.map((m) => [m.member, m]));
}

test('a member put to sleep shows asleep on the board, and wakes back', () => {
  const ws = workspace();
  try {
    let rows = board(ws);
    assert.equal(rows.builder.state, 'done ok');
    assert.equal(rows.builder.asleep, false);

    assert.match(atris(ws, 'sleep', 'builder'), /builder is asleep/);
    rows = board(ws);
    assert.equal(rows.builder.state, 'asleep');
    assert.equal(rows.builder.asleep, true);
    assert.equal(rows.validator.state, 'done ok', 'sleeping one member leaves the others alone');
    assert.match(atris(ws, 'member', 'board'), /^builder\s+asleep\b/m);

    assert.match(atris(ws, 'wake', 'builder'), /builder is awake/);
    rows = board(ws);
    assert.equal(rows.builder.state, 'done ok');
    assert.equal(rows.builder.asleep, false);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('a slept member with no progress log still shows on the board', () => {
  const ws = workspace();
  try {
    atris(ws, 'sleep', 'scout');
    const rows = board(ws);
    assert.equal(rows.scout.state, 'asleep');
    assert.match(atris(ws, 'member', 'board'), /^scout\s+asleep\b/m);
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
});

test('a run still going when its member sleeps reads as finishing, not awake', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-board-live-'));
  try {
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'builder.log'), `${at} m-1 started: [pid ${process.pid} engine claude] long job\n${at} m-1 editing\n`);
    const [row] = readBoard({ dir, asleep: ['builder'] });
    assert.equal(row.state, 'asleep after this run');
    assert.equal(row.asleep, true);
    assert.match(renderBoard([row], dir), /asleep after this run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a slept member whose last run ended long ago is not hidden', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-board-old-'));
  try {
    const at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'builder.log'), `${at} m-1 started: old job\n${at} m-1 finished: ok\n`);
    assert.equal(readBoard({ dir }).length, 0);
    const rows = readBoard({ dir, asleep: ['builder'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'asleep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

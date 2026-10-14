'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { appendProgress, startedLine } = require('../lib/member-progress');
const { readBoard, followBoard } = require('../lib/member-board');
const cli = path.resolve(__dirname, '../bin/atris.js');
const stamp = '2026-10-14T14:00:00.000Z';
const limit = 256 * 1024;

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-trim-'));
  const previous = process.env.ATRIS_PROGRESS_DIR;
  process.env.ATRIS_PROGRESS_DIR = dir;
  try { fn(dir, path.join(dir, 'architect.log')); }
  finally {
    if (previous === undefined) delete process.env.ATRIS_PROGRESS_DIR;
    else process.env.ATRIS_PROGRESS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seed(file, start, count = 6000) {
  fs.writeFileSync(file, `${stamp} old started: old job\n${stamp} current ${start}\n`
    + `${stamp} current reading café 音楽 ${'x'.repeat(80)}\n`.repeat(count));
}

test('small logs retain their existing bytes', () => fixture((dir, file) => {
  const before = `${stamp} current started: small job\n`;
  fs.writeFileSync(file, before);
  appendProgress('architect', 'reading lib/a.js', 'current');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(before));
  assert.match(text, /current reading lib\/a.js\n$/);
}));

test('large legacy logs keep recent whole UTF-8 lines and current process identity', () => fixture((dir, file) => {
  const start = startedLine('keep the current job', { pid: process.pid, engine: 'codex', run: '0123456789abcdef' });
  seed(file, start);
  const before = fs.statSync(file).size;
  appendProgress('architect', 'editing latest.js', 'current');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(before > limit);
  assert.ok(fs.statSync(file).size <= limit);
  assert.ok(text.startsWith(`${stamp} current ${start}\n`));
  assert.ok(!text.includes('old job'));
  assert.ok(!text.includes('\ufffd'));
  assert.match(text, /current editing latest\.js\n$/);
  for (const line of text.trimEnd().split('\n')) assert.match(line, /^\S+ current /);
  const row = readBoard({ dir, all: true })[0];
  assert.equal(row.job, 'keep the current job');
  assert.equal(row.pid, process.pid);
  assert.equal(row.alive, true);
  assert.equal(row.step, 'editing latest.js');
  assert.deepEqual(fs.readdirSync(dir), ['architect.log']);
}));

test('repeated trimming stays bounded and retains a later run and finish', () => fixture((dir, file) => {
  appendProgress('architect', 'started: first job', 'first');
  for (let i = 0; i < 10000; i++) {
    if (i === 5000) appendProgress('architect', 'started: second job', 'second');
    appendProgress('architect', `reading ${'x'.repeat(90)}`, i < 5000 ? 'first' : 'second');
    assert.ok(fs.statSync(file).size <= limit);
  }
  appendProgress('architect', 'finished: ok', 'second');
  const row = readBoard({ dir, all: true })[0];
  assert.equal(row.job, 'second job');
  assert.equal(row.state, 'done ok');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('first job'));
}));

test('old files without a start marker still trim and the real board command reads the finish', () => fixture((dir, file) => {
  fs.writeFileSync(file, `${stamp} current reading old.js\n`.repeat(15000));
  appendProgress('architect', 'finished: ok', 'current');
  assert.ok(fs.statSync(file).size <= limit);
  const result = spawnSync(process.execPath, [cli, 'member', 'board', '--json', '--all'], {
    encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const row = JSON.parse(result.stdout).members.find((item) => item.member === 'architect');
  assert.equal(row.state, 'done ok');
}));

test('a running follower receives the new step after a trim', () => fixture((dir, file) => {
  seed(file, 'started: current job');
  const events = [];
  const follower = followBoard({ dir, emit: (event) => events.push(event) });
  try {
    appendProgress('architect', 'editing after-trim.js', 'current');
    follower.scan();
    assert.ok(events.some((event) => event.text === 'editing after-trim.js'));
    appendProgress('architect', 'finished: ok', 'current');
    follower.scan();
    assert.ok(events.some((event) => event.kind === 'finished' && event.ok));
  } finally { follower.stop(); }
}));

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberStopCommand } = require('../lib/member-board');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-stop-command-'));
  const saved = { HOME: process.env.HOME, ATRIS_PROGRESS_DIR: process.env.ATRIS_PROGRESS_DIR };
  process.env.HOME = home;
  delete process.env.ATRIS_PROGRESS_DIR;
  const dir = path.join(home, '.atris', 'progress');
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return dir;
}

async function outputFor(name) {
  const calls = [];
  const original = console.log;
  console.log = (...args) => calls.push(args);
  try {
    const result = await memberStopCommand(name);
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(calls, [['nothing running']]);
  } finally {
    console.log = original;
  }
}

test('memberStopCommand reports a named member with no progress log', async (t) => {
  const dir = fixture(t);
  await outputFor('builder');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('memberStopCommand leaves a finished run unchanged, including padded names', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'builder.log');
  const log = '2024-01-02T03:00:00.000Z mission-1 started: build the page\n'
    + '2024-01-02T03:01:00.000Z mission-1 finished: ok\n';
  fs.writeFileSync(file, log);
  await outputFor('  builder  ');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), log);
});

test('memberStopCommand handles empty and invalid member names', async (t) => {
  const dir = fixture(t);
  for (const name of [undefined, null, '', '   ', '../builder', 'team/builder']) {
    await outputFor(name);
  }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('memberStopCommand leaves empty, malformed, and legacy untagged logs unchanged', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'builder.log');
  for (const log of ['', 'not a progress line\n',
    '2024-01-02T03:00:00.000Z mission-1 started: legacy job without a pid\n']) {
    fs.writeFileSync(file, log);
    await outputFor('builder');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), log);
  }
});

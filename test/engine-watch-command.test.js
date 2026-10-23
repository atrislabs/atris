'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runEngineWatchCommand } = require('../commands/engine-watch');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-watch-cmd-'));
}

function writeReceipt(root, id, receiptData, logContent = '') {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const liveLogRel = path.join('atris', 'runs', `${id}.live.log`);
  fs.writeFileSync(path.join(root, liveLogRel), logContent, 'utf8');
  const receipt = {
    live_log: liveLogRel,
    ...receiptData,
  };
  fs.writeFileSync(path.join(runsDir, `${id}.json`), JSON.stringify(receipt, null, 2), 'utf8');
}

test('runEngineWatchCommand handles empty roster and missing receipt queries', async () => {
  const root = makeTempDir();
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  const messages = [];
  const log = (msg) => messages.push(String(msg));

  try {
    const exitCodeEmpty = await runEngineWatchCommand([], root, { log });
    assert.strictEqual(exitCodeEmpty, 0);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0], 'no engine work is running.');

    messages.length = 0;
    const exitCodeMissing = await runEngineWatchCommand(['missing-run'], root, { log });
    assert.strictEqual(exitCodeMissing, 2);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0], 'engine watch: no receipt found for missing-run');
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runEngineWatchCommand resolves latest run and prints tailed log with --no-follow', async () => {
  const root = makeTempDir();
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  const messages = [];
  const log = (msg) => messages.push(String(msg));

  try {
    writeReceipt(root, 'run-early', {
      engine: 'claude',
      status: 'completed',
      started_at: '2026-10-20T10:00:00.000Z',
    }, 'first entry\n');

    writeReceipt(root, 'run-recent', {
      engine: 'codex',
      status: 'completed',
      started_at: '2026-10-21T12:00:00.000Z',
    }, 'step 1\nstep 2\n');

    const exitCode = await runEngineWatchCommand(['latest', '--no-follow'], root, { log });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(messages.length, 3);
    assert.match(messages[0], /run-recent\s+codex\s+completed\s+started 2026-10-21T12:00:00.000Z/);
    assert.strictEqual(messages[1], 'step 1');
    assert.strictEqual(messages[2], 'step 2');
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runEngineWatchCommand informs when live log is empty', async () => {
  const root = makeTempDir();
  const prevHome = process.env.HOME;
  process.env.HOME = root;
  const messages = [];
  const log = (msg) => messages.push(String(msg));

  try {
    writeReceipt(root, 'run-empty', {
      engine: 'cursor',
      status: 'completed',
      started_at: '2026-10-22T08:00:00.000Z',
    }, '');

    const exitCode = await runEngineWatchCommand(['run-empty', '--no-follow'], root, { log });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(messages.length, 2);
    assert.match(messages[0], /run-empty\s+cursor\s+completed/);
    assert.strictEqual(messages[1], 'no live output yet.');
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

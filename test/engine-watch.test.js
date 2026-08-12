'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { engineCommand } = require('../commands/engine');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-watch-'));
}

function writeRun(root, id, receipt, lines = []) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const liveLog = path.join('atris', 'runs', `${id}.live.log`);
  fs.writeFileSync(path.join(root, liveLog), lines.length ? `${lines.join('\n')}\n` : '');
  fs.writeFileSync(path.join(runsDir, `${id}.json`), `${JSON.stringify({
    schema: 'atris.engine_ask_receipt.v1',
    live_log: liveLog,
    ...receipt,
  }, null, 2)}\n`);
}

test('engine watch latest --no-follow prints status and only the last 20 live lines', async () => {
  const root = tempRoot();
  const output = [];
  try {
    writeRun(root, 'engine-ask-old', {
      status: 'completed',
      pid: process.pid,
      engine: 'cursor',
      started_at: '2026-08-12T10:00:00.000Z',
    }, ['old answer']);
    writeRun(root, 'engine-ask-new', {
      status: 'running',
      pid: process.pid,
      engine: 'codex',
      started_at: '2026-08-12T11:00:00.000Z',
    }, Array.from({ length: 25 }, (_, index) => `line ${index + 1}`));

    const code = await engineCommand(['watch', 'latest', '--no-follow'], {
      root,
      engineWatch: { log: (line = '') => output.push(String(line)), pidIsAlive: () => true },
    });
    assert.equal(code, 0);
    assert.match(output[0], /engine-ask-new\s+codex\s+running\s+started/);
    assert.deepEqual(output.slice(1), Array.from({ length: 20 }, (_, index) => `line ${index + 6}`));
    assert.equal(output.some((line) => line.includes('old answer')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine watch roster lists only running receipts and marks a dead pid presumed dead', async () => {
  const root = tempRoot();
  const output = [];
  try {
    writeRun(root, 'engine-ask-live', {
      status: 'running',
      pid: 111,
      engine: 'cursor',
      started_at: '2026-08-12T11:00:00.000Z',
    }, ['still working']);
    writeRun(root, 'engine-ask-dead', {
      status: 'running',
      pid: 222,
      engine: 'codex',
      started_at: '2026-08-12T10:00:00.000Z',
    }, ['last words']);
    writeRun(root, 'engine-ask-done', {
      status: 'completed',
      pid: 333,
      engine: 'claude',
      started_at: '2026-08-12T09:00:00.000Z',
    }, ['done']);

    const code = await engineCommand(['watch'], {
      root,
      engineWatch: {
        log: (line = '') => output.push(String(line)),
        pidIsAlive: (pid) => pid === 111,
        nowMs: Date.parse('2026-08-12T11:00:10.000Z'),
      },
    });
    assert.equal(code, 0);
    assert.equal(output.length, 2);
    assert.match(output[0], /engine-ask-live\s+cursor\s+running\s+started .+last log/);
    assert.match(output[1], /engine-ask-dead\s+codex\s+presumed dead\s+started .+last log/);
    assert.equal(output.some((line) => line.includes('engine-ask-done')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('roster reports recent output for a nonempty live log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-age-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  try {
    process.env.HOME = root;
    process.chdir(root);
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const liveLog = path.join(runs, 'sample.live.log');
    fs.writeFileSync(liveLog, 'working on the requested change\n');
    const modified = new Date('2026-08-12T11:00:00.000Z');
    fs.utimesSync(liveLog, modified, modified);
    fs.writeFileSync(path.join(runs, 'sample.json'), JSON.stringify({
      schema: 'atris.engine_ask_receipt.v1',
      engine: 'codex',
      status: 'running',
      pid: 111,
      started_at: '2026-08-12T10:00:00.000Z',
      live_log: liveLog,
    }));
    const output = [];
    await runEngineWatchCommand([], root, {
      log: (line) => output.push(String(line)),
      pidIsAlive: () => true,
      nowMs: Date.parse('2026-08-12T11:00:10.000Z'),
    });
    assert.match(output.find((line) => line.includes('sample')) || '', /last log\s+10s/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

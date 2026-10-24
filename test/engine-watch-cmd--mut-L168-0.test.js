'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('running job log age uses the supplied clock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-age-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const liveLog = path.join(runs, 'sample.live.log');
    fs.writeFileSync(liveLog, 'working\n');
    const loggedAt = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(liveLog, loggedAt, loggedAt);
    fs.writeFileSync(path.join(runs, 'sample.json'), JSON.stringify({
      status: 'running',
      engine: 'codex',
      pid: process.pid,
      started_at: loggedAt.toISOString(),
      live_log: path.join('atris', 'runs', 'sample.live.log'),
    }));
    const output = [];
    await runEngineWatchCommand([], root, {
      nowMs: loggedAt.getTime() + 120000,
      log: (line) => output.push(String(line)),
      pidIsAlive: () => true,
    });
    assert.match(output.find((line) => line.includes('sample')) || '', /last log\s+2m ago\b/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('a running receipt for the current process is displayed as running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-watch-live-pid-'));
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'live-run.json'), JSON.stringify({
      engine: 'codex',
      status: 'running',
      pid: process.pid,
      started_at: '2020-01-02T03:04:05.000Z',
      live_log: 'atris/runs/live-run.log',
    }));
    const messages = [];
    const result = await runEngineWatchCommand(['live-run', '--no-follow'], root, {
      log: (message) => messages.push(message),
    });
    assert.equal(result, 0);
    assert.deepEqual(messages, [
      'live-run  codex  running  started 2020-01-02T03:04:05.000Z',
      'no live output yet.',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

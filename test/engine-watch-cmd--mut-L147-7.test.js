'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('following a running receipt emits new output at the requested poll interval', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-watch-poll-'));
  t.mock.timers.enable({ apis: ['setInterval'] });

  try {
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const logPath = path.join(runsDir, 'sample.live.log');
    const receiptPath = path.join(runsDir, 'sample.json');
    const receipt = {
      engine: 'sample',
      status: 'running',
      pid: 123,
      started_at: '2020-01-01T00:00:00.000Z',
      live_log: logPath,
    };
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const output = [];
    const result = runEngineWatchCommand(['sample'], root, {
      pollMs: 37,
      pidIsAlive: () => true,
      log: () => {},
      write: (chunk) => output.push(chunk),
    });

    fs.appendFileSync(logPath, 'finished\n');
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, status: 'completed' }));
    t.mock.timers.tick(36);
    assert.deepEqual(output, []);
    t.mock.timers.tick(1);
    assert.deepEqual(output, ['finished\n']);
    assert.equal(await result, 0);
  } finally {
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

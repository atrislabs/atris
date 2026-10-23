'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('following a receipt reads new output through the injected filesystem', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-injected-fs-'));
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const liveLog = path.join(runs, 'example.live.log');
    fs.writeFileSync(liveLog, '');
    fs.writeFileSync(path.join(runs, 'example.json'), JSON.stringify({
      engine: 'codex',
      status: 'running',
      pid: 123,
      started_at: '2020-01-01T00:00:00.000Z',
      live_log: liveLog,
    }));

    let logStats = 0;
    const injectedFs = Object.create(fs);
    injectedFs.statSync = (file, ...args) => {
      const stat = fs.statSync(file, ...args);
      // The first stat tails the empty log; the second establishes the follow offset.
      if (file === liveLog && ++logStats === 2) {
        fs.appendFileSync(liveLog, 'new output from the injected filesystem\n');
      }
      return stat;
    };
    const messages = [];
    const output = [];
    let aliveChecks = 0;
    const result = await runEngineWatchCommand(['example'], root, {
      fs: injectedFs,
      log: (message) => messages.push(message),
      write: (chunk) => output.push(chunk),
      pidIsAlive: () => ++aliveChecks === 1,
      pollMs: 1,
    });

    assert.equal(result, 0);
    assert.deepEqual(messages, [
      'example  codex  running  started 2020-01-01T00:00:00.000Z',
      'no live output yet.',
    ]);
    assert.equal(output.join(''), 'new output from the injected filesystem\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

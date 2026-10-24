'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runEngineWatchCommand } = require('../commands/engine-watch');

test('latest skips a newer receipt that has no live log', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-missing-log-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'watchable.json'), JSON.stringify({
      status: 'completed',
      started_at: '2020-01-01T00:00:00.000Z',
      live_log: path.join('atris', 'runs', 'output.log'),
    }));
    fs.writeFileSync(path.join(runs, 'output.log'), 'selected-log-marker\n');
    fs.writeFileSync(path.join(runs, 'without-log.json'), JSON.stringify({
      status: 'completed',
      started_at: '2020-01-02T00:00:00.000Z',
    }));
    const messages = [];
    await runEngineWatchCommand(['latest', '--no-follow'], root, {
      log: (message) => messages.push(String(message)),
    });
    assert.equal(messages.includes('selected-log-marker'), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

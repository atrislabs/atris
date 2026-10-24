'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchAtris } = require('../commands/watch');

test('stop finds a watch by its display name when its saved slug differs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-name-stop-'));
  const stateDir = path.join(tmp, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ledger = path.join(stateDir, 'missions.jsonl');
  fs.writeFileSync(ledger, JSON.stringify({
    schema: 'atris.mission.v1',
    id: 'mission-latency-monitor',
    slug: 'legacy-latency',
    objective: 'check latency',
    owner: 'watcher',
    status: 'planning',
    cadence: '1h',
    runner: 'claude',
    lane: 'watch',
    always_on: true,
    metadata: { watch: true, watch_slug: 'latency' },
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    n: 1,
  }) + '\n');

  const original = {
    cwd: process.cwd(), home: process.env.HOME, argv: process.argv,
    exit: process.exit, log: console.log, error: console.error,
  };
  class ExitSignal extends Error {}
  try {
    process.env.HOME = tmp;
    process.chdir(tmp);
    process.argv = ['node', 'atris', 'watch', 'stop', 'latency'];
    process.exit = () => { throw new ExitSignal(); };
    console.log = () => {};
    console.error = () => {};
    try {
      watchAtris();
    } catch (err) {
      if (!(err instanceof ExitSignal)) throw err;
    }
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.at(-1).status, 'stopped');
  } finally {
    process.chdir(original.cwd);
    if (original.home === undefined) delete process.env.HOME;
    else process.env.HOME = original.home;
    process.argv = original.argv;
    process.exit = original.exit;
    console.log = original.log;
    console.error = original.error;
  }
});

'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchAtris } = require('../commands/watch');

test('listing a watch without an optional watch name uses its mission slug', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-slug-'));
  const state = path.join(tmp, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
    schema: 'atris.mission.v1',
    id: 'mission-latency-internal',
    slug: 'latency-alerts',
    objective: 'check latency',
    owner: 'watcher',
    status: 'planning',
    cadence: '1h',
    runner: 'claude',
    lane: 'watch',
    always_on: true,
    metadata: { watch: true },
  }) + '\n');

  const original = {
    cwd: process.cwd(), home: process.env.HOME, argv: process.argv,
    exit: process.exit, log: console.log, error: console.error,
  };
  const lines = [];
  const exitSignal = new Error('command exited');
  try {
    process.chdir(tmp);
    process.env.HOME = tmp;
    process.argv = ['node', 'atris', 'watch', 'list'];
    process.exit = () => { throw exitSignal; };
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));
    try {
      watchAtris();
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.ok(lines.some(line => line.trim().split(/\s+/)[0] === 'latency-alerts'),
      'the displayed watch name should use the saved mission slug');
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

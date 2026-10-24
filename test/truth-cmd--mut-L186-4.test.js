'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { truthCommand } = require('../commands/truth');

test('an overdue global loop with zero consecutive failures is stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-failures-'));
  const heartbeat = path.join(dir, '.atris', 'heartbeat');
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(heartbeat, { recursive: true });
  fs.writeFileSync(path.join(heartbeat, 'registry.json'), JSON.stringify({
    jobs: [{ id: 'overdue-loop', cadence_minutes: 60, enabled: true }],
  }));
  fs.writeFileSync(path.join(heartbeat, 'state.json'), JSON.stringify({
    'overdue-loop': { last_run: '2000-01-01T00:00:00.000Z', consecutive_fails: 0 },
  }));

  const cwd = process.cwd();
  const keys = ['HOME', 'ATRIS_HOME', 'ATRIS_HEARTBEAT_DIR', 'ATRIS_TASKS_DB', 'ATRIS_TEST_STATE_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.ATRIS_HOME = dir;
    process.env.ATRIS_HEARTBEAT_DIR = heartbeat;
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    process.env.ATRIS_TEST_STATE_DIR = dir;
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = code => { throw new Error(`unexpected exit: ${code}`); };
    truthCommand(['--global', '--json']);
    const report = JSON.parse(output.join('\n'));
    assert.strictEqual(report.loop_rows.find(row => row.id === 'overdue-loop').verdict, 'stale');
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.error = error;
    process.exit = exit;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

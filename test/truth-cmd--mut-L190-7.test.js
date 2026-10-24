'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('account loop report preserves consecutive failure count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-failure-count-'));
  const previousCwd = process.cwd();
  const keys = ['HOME', 'ATRIS_HEARTBEAT_DIR', 'ATRIS_TASKS_DB', 'ATRIS_TEST_STATE_DIR'];
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const previousLog = console.log;
  const output = [];
  try {
    process.env.HOME = dir;
    process.env.ATRIS_HEARTBEAT_DIR = dir;
    process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
    process.env.ATRIS_TEST_STATE_DIR = dir;
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, 'atris'));
    const heartbeatDir = path.join(dir, '.atris', 'heartbeat');
    fs.mkdirSync(heartbeatDir, { recursive: true });
    fs.writeFileSync(path.join(heartbeatDir, 'registry.json'), JSON.stringify({
      jobs: [{ id: 'daily-check', enabled: true, command: 'true', cadence_minutes: 15 }],
    }));
    fs.writeFileSync(path.join(heartbeatDir, 'state.json'), JSON.stringify({
      'daily-check': { consecutive_fails: 3 },
    }));
    const { truthCommand } = require('../commands/truth');
    console.log = (...args) => output.push(args.join(' '));
    truthCommand(['--global', '--json']);
    const row = JSON.parse(output.join('\n')).loop_rows.find(item => item.id === 'daily-check');
    assert.strictEqual(row.fails, 3);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

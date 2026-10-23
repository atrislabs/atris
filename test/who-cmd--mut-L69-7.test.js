'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('clearing workforce runs preserves a finished record without an engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-clear-other-run-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  try {
    process.env.HOME = root;
    process.chdir(root);
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    console.log = () => {};
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const file = path.join(runs, 'completed.json');
    fs.writeFileSync(file, JSON.stringify({
      status: 'completed',
      started_at: '2026-08-15T12:00:00.000Z',
      finished_at: '2026-08-15T12:05:00.000Z',
      result: { passed: true },
    }));
    whoCommand(['--clear'], {
      root,
      now: () => Date.parse('2026-08-16T12:00:00.000Z'),
      processes: [],
      write: () => {},
    });
    assert.equal(fs.existsSync(file), true);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

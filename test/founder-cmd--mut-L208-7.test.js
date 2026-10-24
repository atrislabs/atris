'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { founderCommand } = require('../commands/founder');

test('counts a task closed by a completed event without a type alias', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-event-score-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'atris'));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{
        id: 'finished-task',
        status: 'done',
        events: [{ event_type: 'completed', created_at: '2026-08-06T12:00:00Z' }],
      }],
    }));
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    founderCommand(['--json'], {
      cwd: root,
      env: { HOME: root, ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' },
    });
    assert.strictEqual(JSON.parse(output.join('\n')).tasksThisWeek, 1);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

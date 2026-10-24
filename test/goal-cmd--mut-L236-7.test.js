'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('today counts completed tasks using the supplied calendar date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-calendar-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    const { run } = require('../commands/goal');
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ status: 'done', done_at: '2001-06-15T12:00:00.000Z' }],
    }));

    function today(date) {
      const output = [];
      console.log = (...args) => output.push(args.join(' '));
      run(['--json'], { cwd: dir, now: new Date(date) });
      return JSON.parse(output.join('\n')).today;
    }

    assert.match(today('2001-06-15T12:00:00.000Z'), /\b1 task landed\b/);
    assert.match(today('2002-06-15T12:00:00.000Z'), /\b0 tasks landed\b/);
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

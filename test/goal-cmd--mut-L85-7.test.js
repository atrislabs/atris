'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('completion events count as landed tasks on their recorded day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-completion-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ id: 'completed-task', title: 'Ship the fix', status: 'done', events: [
        { event_type: 'done', created_at: '2025-02-12T12:00:00.000Z' },
      ] }],
    }));
    console.log = (...args) => lines.push(args.join(' '));
    run([], { cwd: dir, now: new Date('2025-02-12T12:00:00.000Z') });
    assert.match(lines.find(line => /today/.test(line)) || '', /1 task landed/);
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

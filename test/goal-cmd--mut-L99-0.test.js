'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('only completed tasks on the supplied day count as landed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landed-day-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    console.log = (...args) => output.push(args.join(' '));
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { status: 'done', done_at: '2024-06-12T12:00:00.000Z' },
        { status: 'done', done_at: '2024-06-12T13:00:00.000Z' },
        { status: 'done', done_at: '2024-06-09T12:00:00.000Z' },
      ],
    }));
    run([], { cwd: dir, now: new Date('2024-06-12T14:00:00.000Z') });
    assert.match(output.join('\n'), /\b2 tasks landed\b/);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

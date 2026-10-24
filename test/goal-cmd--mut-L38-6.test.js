'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('metrics without a value are omitted from the goal view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-incomplete-metric-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'scoreboard.json'), JSON.stringify({
      goal: 'book demos',
      metrics: [{ name: 'demos booked' }],
    }));
    run(['--json'], { cwd: dir, now: new Date('2024-01-15T12:00:00Z') });
    assert.strictEqual(JSON.parse(output.join('\n')).metrics.length, 0);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

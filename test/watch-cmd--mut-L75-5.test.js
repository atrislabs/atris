'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { watchAtris } = require('../commands/watch');

test('a watch checked just now displays a relative age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-age-'));
  const original = {
    cwd: process.cwd(), home: process.env.HOME, argv: process.argv,
    exit: process.exit, log: console.log, now: Date.now,
  };
  const output = [];
  const now = Date.parse('2026-01-15T12:00:00.000Z');
  const exited = Symbol('exit');
  function run(args) {
    process.argv = ['node', 'atris', 'watch', ...args];
    try {
      watchAtris();
    } catch (error) {
      if (error !== exited) throw error;
    }
  }
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    Date.now = () => now;
    process.exit = (code) => {
      if (code) throw new Error(`unexpected exit ${code}`);
      throw exited;
    };
    console.log = (...items) => output.push(items.join(' '));
    run(['check service health', '--name', 'service-health']);
    const file = path.join(dir, '.atris', 'state', 'missions.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n');
    const mission = JSON.parse(records[records.length - 1]);
    mission.last_tick_at = new Date(now).toISOString();
    fs.appendFileSync(file, `${JSON.stringify(mission)}\n`);
    output.length = 0;
    run(['list']);
    const row = output.find(line => line.includes('service-health'));
    assert.match(row, /\bjust now\b/);
  } finally {
    Date.now = original.now;
    console.log = original.log;
    process.exit = original.exit;
    process.argv = original.argv;
    process.chdir(original.cwd);
    if (original.home === undefined) delete process.env.HOME;
    else process.env.HOME = original.home;
  }
});

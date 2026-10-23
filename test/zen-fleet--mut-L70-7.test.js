'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fleetZen } = require('../lib/zen-fleet');

test('an unrepairable map link remains in the personal action list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-personal-actions-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'atris', 'MAP.md'), '`missing.js:7`\n');
    fs.writeFileSync(path.join(home, 'schedule'), '');
    const schedule = process.env.ATRIS_ZEN_SCHEDULE_FILE;
    process.env.ATRIS_ZEN_SCHEDULE_FILE = path.join(home, 'schedule');
    try {
      const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
      if (init.status !== 0) throw new Error(init.stderr);
      const [result] = fleetZen({ repos: [repo], fetch: false });
      assert.equal(result.yours.some(item => item.cmd === 'atris clean'), true);
    } finally {
      if (schedule === undefined) delete process.env.ATRIS_ZEN_SCHEDULE_FILE;
      else process.env.ATRIS_ZEN_SCHEDULE_FILE = schedule;
    }
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a stopped member without a mission reports that absence', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-mission-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { runAliveTick } = require('../lib/member-alive');
    const atrisBin = path.join(home, 'fixture-cli.js');
    fs.writeFileSync(atrisBin, `
      process.stdout.write(JSON.stringify({
        decision: 'stop', reason: 'no_active_mission', needs_user: false,
        checks: { has_mission: false, has_goal: false }
      }));
    `);
    const tick = runAliveTick('demo', {
      execute: true, confirmed: true, noPrime: true, atrisBin, cwd: home,
    });
    assert.strictEqual(tick.has_mission, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

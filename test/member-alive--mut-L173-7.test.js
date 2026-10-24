'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAliveTick } = require('../lib/member-alive');

test('a stopped wake preserves its request for user input', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-ask-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const atrisBin = path.join(home, 'fixture-cli.js');
    fs.writeFileSync(atrisBin, `
      process.stdout.write(JSON.stringify({
        decision: 'stop',
        reason: 'execute_requires_confirm_autonomy_policy',
        needs_user: true,
        ask: 'Define a concrete mission before starting work.',
        checks: { has_member: true, has_mission: false, has_goal: false }
      }));
    `);
    const tick = runAliveTick('demo', {
      execute: true, confirmed: true, noPrime: true, atrisBin, cwd: home,
    });
    assert.strictEqual(tick.needs_user, true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

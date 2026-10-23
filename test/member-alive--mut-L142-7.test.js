'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAliveTick } = require('../lib/member-alive');

test('a runnable wake keeps its decision in the returned tick', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-decision-'));
  const previousEnv = process.env;
  process.env = { ...previousEnv, HOME: home };
  try {
    const atrisBin = path.join(home, 'wake-fixture.js');
    fs.writeFileSync(atrisBin, `
      process.stdout.write(JSON.stringify({
        decision: 'run',
        reason: 'ready',
        needs_user: false,
        checks: { has_mission: true, has_goal: true }
      }));
    `);
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'member-operate.js'),
      "console.log(JSON.stringify({ ok: true, executed: true }));");
    const tick = runAliveTick('demo', {
      execute: true,
      confirmed: true,
      noPrime: true,
      atrisBin,
      cwd: home,
    });
    assert.strictEqual(tick.decision, 'run');
  } finally {
    process.env = previousEnv;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

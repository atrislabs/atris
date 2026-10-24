'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('doctor explains that an existing repair mission already covers the finding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-doctor-existing-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const { runLoopDoctor } = require('../commands/improve');
    const mission = {
      id: 'mission-existing-repair',
      objective: '[loop-doctor:reward_flatline] restore positive rewards',
      status: 'planning',
    };
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), `${JSON.stringify({ mission })}\n`);

    const result = runLoopDoctor(['--fix'], {
      workspace: root,
      now: new Date('2026-07-10T12:00:00.000Z'),
      scanLoopReceipts: () => [{
        kind: 'reward_flatline',
        count: 2,
        evidence: { detail: 'recent ticks earned no reward' },
        suggested_mission: {
          objective: 'restore positive rewards',
          owner: 'auto-improver',
          verifier: 'atris improve doctor --check reward_flatline',
          cadence: '15m',
        },
      }],
      startMission: () => { throw new Error('the existing repair should be reused'); },
    });

    assert.equal(result.fix.action, 'mission_exists');
    assert.match(output.join('\n'), /no mission filed:\s+mission-existing-repair\s+already covers the top finding\./);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

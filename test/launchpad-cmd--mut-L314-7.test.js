'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('running mission keeps its objective in the suggested action and preview', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-objective-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];
  const objective = 'Make checkout accessible';
  try {
    process.env.HOME = home;
    process.chdir(home);
    fs.mkdirSync(path.join(home, 'atris'));
    const state = path.join(home, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'mission-example',
      owner: 'tester',
      status: 'running',
      objective,
      verifier: 'node --test',
    }) + '\n');
    const { launchpadCommand } = require('../commands/launchpad');
    console.log = (...values) => output.push(values.join(' '));
    launchpadCommand(['--json', '--as', 'tester']);
    const result = JSON.parse(output.join('\n'));
    assert.strictEqual(result.next_action.mission.objective, objective);
    assert.strictEqual(result.previews.missions[0].objective, objective);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

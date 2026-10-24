'use strict';
require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('claimed work awaiting human approval is skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-metadata-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, 'atris'));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ id: 'saved-task', title: 'Repair the parser', status: 'claimed', claimed_by: 'tester', metadata: {
        exit_condition: 'Wait for human approval', verify: 'manual review', task_goal: 'Get human approval',
      } }],
    }));
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({schema: 'atris.mission.v1', id: 'active-mission', objective: 'Repair parser', owner: 'tester', status: 'running', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z'}) + '\n');
    process.chdir(root);
    console.log = (...values) => lines.push(values.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    launchpadCommand(['--json', '--as', 'tester']);
    const payload = JSON.parse(lines.join('\n'));
    assert.equal(payload.next_action.kind, 'ask_for_work');
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

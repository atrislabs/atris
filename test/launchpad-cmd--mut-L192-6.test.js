'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('launchpad JSON preserves the hidden completed count from the task surface', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-hidden-done-'));
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const output = [];
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ id: 'pending-task', title: 'Check the saved count', status: 'open' }],
      surface: { hidden_done_count: 7 },
    }));
    process.chdir(root);
    console.log = (...values) => output.push(values.join(' '));

    assert.equal(launchpadCommand(['--json', '--as', 'tester']), 0);
    const payload = JSON.parse(output.join('\n'));
    assert.equal(payload.schema, 'atris.launchpad.v1');
    assert.equal(payload.counts.hidden_done, 7);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

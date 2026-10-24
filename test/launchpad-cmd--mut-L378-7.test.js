'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchpadCommand } = require('../commands/launchpad');

test('suggests finishing work claimed by the selected actor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claimed-suggestion-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ id: 'task-owned', title: 'Repair the reply check', status: 'claimed', claimed_by: 'Codex', created_at: 1700000000000, updated_at: 1700000000000 }],
    }));
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'), JSON.stringify({ id: 'mission-running', objective: 'Repair replies', status: 'running', owner: 'codex' }) + '\n');
    process.chdir(root);
    console.log = (...values) => lines.push(values.join(' '));
    launchpadCommand(['--json', '--as', 'codex']);
    const payload = JSON.parse(lines.join('\n'));
    assert.equal(payload.suggestions.some(item => item.ref === 'task-owned'), true);
  } finally {
    console.log = log;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});

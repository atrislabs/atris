'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('done without a reference selects the most recently updated claimed task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-recent-task-'));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = path.join(root, 'home');
    process.env.USER = 'alex';
    process.env.LOGNAME = 'alex';
    fs.mkdirSync(process.env.HOME);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    process.chdir(root);

    const tasks = [
      { id: 'recent-page', display_id: 'T42', title: 'Build a booking page', updated_at: 1704240000000 },
      { id: 'older-menu', display_id: 'T41', title: 'Build a restaurant menu', updated_at: 1704067200000 },
    ].map(task => ({
      ...task,
      status: 'claimed',
      claimed_by: 'alex',
      created_at: '2024-01-01T00:00:00.000Z',
      claimed_at: '2024-01-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks }));

    const { doneAtris } = require('../commands/done');
    const output = [];
    const code = doneAtris(['--json'], { root, builder: 'claude', log: line => output.push(line) });
    const payload = JSON.parse(output.join('\n'));
    assert.equal(payload.task.title, 'Build a booking page');
    assert.equal(code, 0);
  } finally {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
